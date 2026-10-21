from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload, selectinload

from src.config.database import get_db
from src.models import Application, ApplicationStatus, User
from src.api.serializers import application_data

router = APIRouter(tags=["Applications"])


@router.get("/applications/{application_id}/prep-guide")
def get_prep_guide(application_id: int, db: Session = Depends(get_db)):
    application = db.get(Application, application_id)
    if application is None:
        raise HTTPException(404, "Application not found")
    if application.prep_guide is None:
        raise HTTPException(404, "Prep guide is not ready yet")
    return {
        **(application.prep_guide.structured_data or {}),
        "company": application.job.company,
        "role": application.job.title,
        "company_intel": application.prep_guide.company_intel or {},
    }


@router.get("/applications/{user_id}")
def list_applications(
    user_id: int,
    status: ApplicationStatus | None = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
):
    if db.get(User, user_id) is None:
        raise HTTPException(404, "Profile not found")
    query = db.query(Application).filter(Application.user_id == user_id)
    if status:
        query = query.filter(Application.status == status)
    total = query.count()
    rows = (
        query.options(
            joinedload(Application.job),
            joinedload(Application.prep_guide),
            selectinload(Application.status_history),
        )
        .order_by(Application.created_at.desc(), Application.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "items": [application_data(row) for row in rows],
        "total": total,
        "page": page,
        "page_size": page_size,
    }
