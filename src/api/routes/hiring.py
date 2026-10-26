from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from src.agents.hiring_shortlist_agent import HiringShortlistAgent
from src.config.database import get_db
from src.models import Shortlist
from src.utils.hiring_evidence import render_hiring_report

router = APIRouter(prefix="/hiring", tags=["Hiring"])


class ShortlistRequest(BaseModel):
    jd_text: str = Field(min_length=1, max_length=30000)
    applicants: list[dict] | str
    shortlist_size: int = Field(20, ge=1, le=200, strict=True)


@router.post("/shortlist")
def shortlist(request: ShortlistRequest, http_request: Request, db: Session = Depends(get_db)):
    if len(request.applicants) > (
        2000000 if isinstance(request.applicants, str) else 10000
    ):
        raise HTTPException(413, "Applicant pool is too large")
    try:
        return HiringShortlistAgent().shortlist(
            request.jd_text, request.applicants, request.shortlist_size, db=db, owner_id=http_request.state.owner_id
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/shortlists")
def list_shortlists(request: Request, page: int = 1, page_size: int = 20, db: Session = Depends(get_db)):
    if page < 1 or not 1 <= page_size <= 50:
        raise HTTPException(422, "Use positive page and page_size up to50")
    query = db.query(Shortlist).filter(Shortlist.user_id == request.state.owner_id)
    return {"items": [{"id": row.id, "state": "completed", "created_at": row.created_at, "applicant_count": row.applicant_count, "html_url": f"/hiring/shortlists/{row.id}/report.html"} for row in query.order_by(Shortlist.id.desc()).offset((page-1)*page_size).limit(page_size)], "total": query.count(), "page": page, "page_size": page_size}


def _owned(request, db, shortlist_id):
    row = db.get(Shortlist, shortlist_id)
    if row is None or row.user_id != request.state.owner_id:
        raise HTTPException(404, "Hiring report not found")
    return row


@router.get("/shortlists/{shortlist_id}")
def get_shortlist(shortlist_id: int, request: Request, db: Session = Depends(get_db)):
    row = _owned(request, db, shortlist_id)
    return {**row.candidates, "id": row.id, "state": "completed", "html_url": f"/hiring/shortlists/{row.id}/report.html"}


@router.get("/shortlists/{shortlist_id}/report.html", response_class=HTMLResponse)
def shortlist_report(shortlist_id: int, request: Request, db: Session = Depends(get_db)):
    row = _owned(request, db, shortlist_id)
    return HTMLResponse(render_hiring_report(row.candidates), headers={"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"})
