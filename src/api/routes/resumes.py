from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session, joinedload

from src.config.database import get_db
from src.config.settings import get_settings
from src.models import Application, User

router = APIRouter(prefix="/resumes", tags=["Resumes"])


@router.get("/{user_id}/files/{filename}")
def resume_file_link(user_id: int, filename: str, db: Session = Depends(get_db)):
    import re

    match = re.fullmatch(r"(\d+)_resume_v(\d+)\.pdf", filename)
    if not match:
        raise HTTPException(404, "Resume not found")
    app = db.query(Application).filter_by(user_id=user_id, job_id=int(match[1])).first()
    if app is None:
        raise HTTPException(404, "Resume not found")
    return download_resume(user_id, app.id, int(match[2]), db)


@router.get("/{user_id}")
def list_resumes(user_id: int, db: Session = Depends(get_db)):
    if db.get(User, user_id) is None:
        raise HTTPException(404, "Profile not found")
    rows = (
        db.query(Application)
        .options(joinedload(Application.job))
        .filter(Application.user_id == user_id, Application.resume_version.isnot(None))
        .order_by(Application.created_at.desc())
        .all()
    )
    items = []
    for app in rows:
        path = (
            Path(app.resume_path)
            if app.resume_path
            else Path(get_settings().local_storage_path)
            / "resumes"
            / str(user_id)
            / f"{app.job_id}_resume_v{app.resume_version}.pdf"
        )
        for version in range(app.resume_version or 1, 0, -1):
            candidate = path.parent / f"{app.job_id}_resume_v{version}.pdf"
            if not candidate.is_file():
                continue
            from datetime import datetime, timezone

            items.append(
                {
                    "application_id": app.id,
                    "company": app.job.company,
                    "role": app.job.title,
                    "version": version,
                    "generated_at": datetime.fromtimestamp(
                        candidate.stat().st_mtime, timezone.utc
                    ),
                    "download_url": f"/resumes/{user_id}/{app.id}/download?version={version}",
                }
            )
    return {"items": items}


@router.get("/{user_id}/{application_id}/download")
def download_resume(
    user_id: int,
    application_id: int,
    version: int | None = Query(None, ge=1),
    db: Session = Depends(get_db),
):
    app = db.get(Application, application_id)
    if (
        app is None
        or app.user_id != user_id
        or (not app.resume_path and version is None)
    ):
        raise HTTPException(404, "Resume not found")
    path = (
        Path(app.resume_path).resolve()
        if app.resume_path
        else (
            Path(get_settings().local_storage_path)
            / "resumes"
            / str(user_id)
            / f"{app.job_id}_resume_v{version}.pdf"
        ).resolve()
    )
    if version is not None:
        path = path.parent / f"{app.job_id}_resume_v{version}.pdf"
    root = (
        Path(get_settings().local_storage_path) / "resumes" / str(user_id)
    ).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise HTTPException(404, "Resume file not found")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=path.name,
        content_disposition_type="inline",
    )
