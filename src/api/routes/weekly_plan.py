from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session, sessionmaker

from src.config.database import get_db
from src.pipelines.quota_selector import QuotaSelector
from src.pipelines.match_scorer import score_jobs_for_user
from src.pipelines.resume_service import ResumeService
from src.pipelines.application_pipeline import process_confirmed_applications
from src.models import Application, ApplicationStatus, User, Job

router = APIRouter(prefix="/weekly-plan", tags=["Weekly Plan"])


class SwapRequest(BaseModel):
    remove_job_id: int
    add_job_id: int


class ConfirmRequest(BaseModel):
    confirmed_job_ids: list[int]


@router.get("/{user_id}")
def get_weekly_plan(user_id: int, db: Session = Depends(get_db)):
    """
    Generates or retrieves the weekly plan for the user, selecting top N jobs.
    """
    try:
        selector = QuotaSelector(db)
        if db.get(User, user_id) is None:
            raise ValueError(f"User {user_id} not found")
        score_jobs_for_user(user_id, db=db)
        plan = selector.generate_weekly_plan(user_id)
        return _enrich_plan(plan, db)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        db.rollback()
        raise HTTPException(
            status_code=503,
            detail="Weekly plan could not be prepared. Please try again.",
        ) from e


@router.post("/{user_id}/swap")
def swap_job(user_id: int, request: SwapRequest, db: Session = Depends(get_db)):
    """
    Swaps a job in the current weekly plan for another pending job.
    """
    try:
        selector = QuotaSelector(db)
        new_plan = selector.swap_job(user_id, request.remove_job_id, request.add_job_id)
        return _enrich_plan(new_plan, db)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{user_id}/confirm")
def confirm_plan(
    user_id: int,
    request: ConfirmRequest,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    """
    Confirms the plan, changing job status to 'confirmed' and advancing to resume generation.
    """
    try:
        selector = QuotaSelector(db)
        drafts = (
            db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.job_id.in_(request.confirmed_job_ids),
                Application.status == ApplicationStatus.planned,
            )
            .all()
        )
        from pathlib import Path

        if any(
            not draft.resume_path or not Path(draft.resume_path).is_file()
            for draft in drafts
        ):
            raise ValueError(
                "Refresh your weekly plan and review the updated resumes before confirming."
            )
        result = selector.confirm_plan(user_id, request.confirmed_job_ids)
        application_ids = [
            row.id
            for row in db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.job_id.in_(request.confirmed_job_ids),
            )
            .all()
        ]
        background_tasks.add_task(
            process_confirmed_applications,
            application_ids,
            sessionmaker(bind=db.get_bind(), expire_on_commit=False),
        )
        return result
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _enrich_plan(plan, db):
    for item in plan["plan"]:
        application = db.get(Application, item["application_id"])
        ResumeService().prepare(application, db)
        item["resume_url"] = f"/resumes/{application.user_id}/{application.id}/download"
        item["resume_version"] = application.resume_version
        item["resume_summary"] = "Review your tailored resume before confirming."
    from datetime import datetime, timedelta, timezone

    user = db.get(User, plan["user_id"])
    blocked = {
        name.lower()
        for name in (user.master_profile or {}).get("blacklist_companies", [])
    }
    rows = (
        db.query(Application)
        .join(Job)
        .filter(
            Application.user_id == plan["user_id"],
            Application.status == ApplicationStatus.pending,
            Job.is_spam.is_(False),
        )
        .order_by(Application.match_score.desc())
        .all()
    )
    alternatives = []
    for application in rows:
        posted = application.job.posted_date
        if posted and posted.tzinfo is None:
            posted = posted.replace(tzinfo=timezone.utc)
        if (
            posted and posted < datetime.now(timezone.utc) - timedelta(days=30)
        ) or application.job.company.lower() in blocked:
            continue
        alternatives.append(
            {
                "application_id": application.id,
                "job_id": application.job_id,
                "company_name": application.job.company,
                "role_title": application.job.title,
                "match_score": application.match_score,
                "skill_gaps": application.skill_gaps,
            }
        )
    plan["alternatives"] = alternatives
    return plan
