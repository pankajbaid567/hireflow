from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from src.agents.report_generator import ReportGenerator
from src.config.database import get_db
from src.config.settings import get_settings
from src.models import WeeklyReport
from src.models import User, Application

router = APIRouter(prefix="/report", tags=["Reports"])


def latest_report(user_id, db):
    row = (
        db.query(WeeklyReport)
        .filter_by(user_id=user_id)
        .order_by(WeeklyReport.week_start_date.desc(), WeeklyReport.id.desc())
        .first()
    )
    if row is None:
        raise HTTPException(404, "No weekly report generated yet")
    return row


@router.post("/{user_id}/generate")
def generate_report(user_id: int, db: Session = Depends(get_db)):
    try:
        return ReportGenerator(db).generate(user_id)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc


@router.get("/{user_id}/latest")
def get_latest_report(user_id: int, db: Session = Depends(get_db)):
    row = latest_report(user_id, db)
    return {
        "id": row.id,
        "week_start": row.week_start_date,
        "content": row.content,
        "metrics": row.metrics,
        "applied_count": row.applied_count,
        "avg_match_score": row.avg_match_score,
        "html_url": f"/report/{user_id}/latest/html",
        "email_sent_at": row.email_sent_at,
        "email_failure_reason": row.email_failure_reason,
    }


@router.get("/{user_id}/latest/html")
def get_latest_html(user_id: int, db: Session = Depends(get_db)):
    row = latest_report(user_id, db)
    if not row.html_path:
        raise HTTPException(404, "Report HTML is not ready")
    path = Path(row.html_path).resolve()
    if (
        not path.is_relative_to(
            (
                Path(get_settings().local_storage_path) / "reports" / str(user_id)
            ).resolve()
        )
        or not path.is_file()
    ):
        raise HTTPException(404, "Report HTML file not found")
    return FileResponse(path, media_type="text/html")


@router.post("/{user_id}/latest/email")
def email_latest_report(user_id: int, db: Session = Depends(get_db)):
    """Explicitly requested delivery; generation alone never sends email."""
    from src.utils.email_service import EmailService

    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "Profile not found")
    report = latest_report(user_id, db)
    path = Path(report.html_path or "").resolve()
    root = (
        Path(get_settings().local_storage_path) / "reports" / str(user_id)
    ).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, "Report HTML file not found")
    application_ids = [
        item["id"] for item in (report.content or {}).get("applications", [])
    ]
    applications = (
        db.query(Application)
        .filter(
            Application.user_id == user_id,
            Application.id.in_(application_ids),
            Application.resume_path.isnot(None),
        )
        .all()
    )
    return EmailService().send_weekly_report(
        user.email,
        path.read_text(encoding="utf-8"),
        [a.resume_path for a in applications],
        db=db,
        report_id=report.id,
    )
