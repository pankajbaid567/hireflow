from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from src.agents.hiring_shortlist_agent import HiringShortlistAgent
from src.config.database import get_db

router = APIRouter(prefix="/hiring", tags=["Hiring"])


class ShortlistRequest(BaseModel):
    jd_text: str = Field(min_length=1, max_length=50000)
    applicants: list[dict] | str
    shortlist_size: int = Field(20, ge=1, le=1000)


@router.post("/shortlist")
def shortlist(request: ShortlistRequest, db: Session = Depends(get_db)):
    if len(request.applicants) > (
        2000000 if isinstance(request.applicants, str) else 10000
    ):
        raise HTTPException(413, "Applicant pool is too large")
    try:
        return HiringShortlistAgent().shortlist(
            request.jd_text, request.applicants, request.shortlist_size, db=db
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
