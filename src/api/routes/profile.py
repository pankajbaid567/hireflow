from io import BytesIO
import json
from pathlib import Path
from uuid import uuid4
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile, status
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from pypdf import PdfReader
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile as StarletteUploadFile

from src.config.database import get_db
from src.config.settings import get_settings
from src.models.user import ConfirmationMode, User, UserMode
from src.models import Application, ApplicationStatus
from src.utils.llm_client import BaseLLMClient, LLMClientError, get_llm_client

router = APIRouter(prefix="/profile", tags=["profile"])


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    email: str
    skills: list[str] = Field(default_factory=list)
    mode: Literal["internship", "job"]
    weekly_quota: int = Field(default=10, ge=1, le=100)
    target_roles: list[str] = Field(default_factory=list)
    preferred_locations: list[str] = Field(default_factory=list)
    phone: str | None = None
    experience_years: float = Field(default=0, ge=0, le=80)
    experience: list[dict[str, Any] | str] = Field(default_factory=list)
    projects: list[dict[str, Any]] = Field(default_factory=list)
    education: list[dict[str, Any]] | dict[str, Any] | str | None = None
    min_stipend: int | None = Field(default=None, ge=0)
    min_salary: int | None = Field(default=None, ge=0)
    summary: str = Field(default="", max_length=3000)
    links: list[dict[str, str]] = Field(default_factory=list)
    certifications: list[str] = Field(default_factory=list)
    achievements: list[str] = Field(default_factory=list)
    languages: list[str] = Field(default_factory=list)
    blacklist_companies: list[str] = Field(default_factory=list)
    confirmation_mode: Literal["batch", "individual"] = "batch"

    model_config = ConfigDict(extra="allow")

    @field_validator(
        "skills",
        "target_roles",
        "preferred_locations",
        "experience",
        "projects",
        "links",
        "certifications",
        "achievements",
        "languages",
        "blacklist_companies",
        mode="before",
    )
    @classmethod
    def normalize_optional_lists(cls, value):
        return [] if value is None else value

    @field_validator("experience_years", mode="before")
    @classmethod
    def normalize_experience_years(cls, value):
        return 0 if value is None else value

    @field_validator("min_stipend", "min_salary", mode="before")
    @classmethod
    def normalize_optional_compensation(cls, value):
        return None if value in (None, "", "null") else value

    @field_validator("email")
    @classmethod
    def validate_email(cls, value: str) -> str:
        if "@" not in value or "." not in value.rsplit("@", 1)[-1]:
            raise ValueError("email must be a valid email address")
        return value

    @field_validator("name")
    @classmethod
    def validate_name(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("name must not be blank")
        return value.strip()


class ProfileResponse(BaseModel):
    id: int
    name: str
    email: str
    mode: UserMode
    weekly_quota: int
    confirmation_mode: ConfirmationMode
    master_profile: dict[str, Any] | None

    model_config = ConfigDict(from_attributes=True)


@router.post("", response_model=ProfileResponse, status_code=status.HTTP_201_CREATED)
async def create_profile(
    request: Request,
    db: Session = Depends(get_db),
) -> User:
    profile = await _profile_from_request(request)
    user = _build_user(profile)

    db.add(user)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A profile with this email already exists.",
        ) from exc

    db.refresh(user)
    return user


@router.patch("/{user_id}", response_model=ProfileResponse)
async def update_profile(user_id: int, request: Request, db: Session = Depends(get_db)):
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(404, "Profile not found.")
    defaults = {
        **(user.master_profile or {}),
        "name": user.name,
        "email": user.email,
        "mode": user.mode.value,
        "weekly_quota": user.weekly_quota,
        "confirmation_mode": user.confirmation_mode.value,
    }
    profile = await _profile_from_request(request, defaults)
    updated = _build_user(profile)
    for key in (
        "name",
        "email",
        "mode",
        "weekly_quota",
        "confirmation_mode",
        "master_profile",
    ):
        setattr(user, key, getattr(updated, key))
    for application in (
        db.query(Application)
        .filter(
            Application.user_id == user_id,
            Application.status.in_(
                [ApplicationStatus.pending, ApplicationStatus.planned]
            ),
        )
        .all()
    ):
        # Previously submitted PDFs are immutable; drafts get a new version
        # when the user next opens the weekly plan.
        application.resume_path = None
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise HTTPException(409, "A profile with this email already exists.") from exc
    db.refresh(user)
    return user


@router.get("/{user_id}", response_model=ProfileResponse)
def get_profile(user_id: int, db: Session = Depends(get_db)) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile not found.",
        )
    return user


async def _profile_from_request(
    request: Request,
    defaults: dict | None = None,
) -> ProfileCreate:
    content_type = request.headers.get("content-type", "")

    if content_type.startswith("application/json"):
        try:
            return ProfileCreate.model_validate(
                {**(defaults or {}), **(await request.json())}
            )
        except ValidationError as exc:
            raise HTTPException(
                status_code=422,
                detail=exc.errors(include_context=False),
            ) from exc
        except (ValueError, TypeError) as exc:
            raise HTTPException(422, "Send a valid profile JSON object") from exc

    if content_type.startswith("multipart/form-data"):
        form = await request.form()
        overrides = {k: v for k, v in form.items() if isinstance(v, str)}
        for field in (
            "skills",
            "target_roles",
            "preferred_locations",
            "experience",
            "education",
            "projects",
            "links",
            "certifications",
            "achievements",
            "languages",
            "blacklist_companies",
        ):
            if field in overrides:
                raw = overrides[field]
                try:
                    overrides[field] = json.loads(raw)
                except json.JSONDecodeError:
                    if field == "education":
                        overrides[field] = raw
                    elif field in {"skills", "target_roles", "preferred_locations", "certifications", "achievements", "languages", "blacklist_companies"}:
                        overrides[field] = [
                            s.strip() for s in raw.split(",") if s.strip()
                        ]
                    else:
                        raise HTTPException(422, f"{field} must contain valid JSON")
        upload = form.get("resume") or form.get("file")
        if not isinstance(upload, (UploadFile, StarletteUploadFile)):
            if not defaults:
                raise HTTPException(
                    400, "Upload a PDF file using form field 'resume' or 'file'."
                )
            data = {**defaults, **overrides}
        else:
            if upload.content_type not in {
                "application/pdf",
                "application/octet-stream",
            }:
                raise HTTPException(400, "Only PDF resume uploads are supported.")
            raw = await upload.read(10 * 1024 * 1024 + 1)
            if len(raw) > 10 * 1024 * 1024:
                raise HTTPException(413, "Resume PDF must be at most 10 MB")
            text = _extract_pdf_text(raw)
            data = {**(defaults or {}), **overrides}
            if not (data.get("name") and data.get("email") and data.get("mode")):
                try:
                    extracted = get_llm_client().extract_profile(text)
                    data = {**extracted, **data}
                except LLMClientError as exc:
                    raise HTTPException(
                        503,
                        "Resume extraction unavailable. Enter name, email, skills and mode along with the PDF.",
                    ) from exc
            data["resume_text"] = text
            directory = Path(get_settings().local_storage_path) / "uploads"
            directory.mkdir(parents=True, exist_ok=True)
            path = directory / f"{uuid4().hex}.pdf"
            path.write_bytes(raw)
            data["master_resume_path"] = str(path.resolve())
        try:
            return ProfileCreate.model_validate(data)
        except ValidationError as exc:
            raise HTTPException(422, exc.errors(include_context=False)) from exc

    raise HTTPException(
        status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        detail="Send either application/json or multipart/form-data.",
    )


async def _profile_from_pdf(
    upload: UploadFile,
    llm_client: BaseLLMClient,
) -> ProfileCreate:
    if upload.content_type not in {"application/pdf", "application/octet-stream"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only PDF resume uploads are supported.",
        )

    resume_text = _extract_pdf_text(await upload.read())
    if not resume_text:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Could not extract text from the uploaded PDF.",
        )

    try:
        extracted = llm_client.extract_profile(resume_text)
        return ProfileCreate.model_validate(extracted)
    except (LLMClientError, ValidationError) as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Could not extract a valid profile from resume: {exc}",
        ) from exc


def _extract_pdf_text(file_bytes: bytes) -> str:
    try:
        reader = PdfReader(BytesIO(file_bytes))
        page_text = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Uploaded file is not a readable PDF.",
        ) from exc

    return "\n".join(page_text).strip()


def _build_user(profile: ProfileCreate) -> User:
    profile_data = profile.model_dump()
    return User(
        name=profile.name,
        email=str(profile.email),
        mode=UserMode(profile.mode),
        weekly_quota=profile.weekly_quota,
        confirmation_mode=ConfirmationMode(profile.confirmation_mode),
        master_profile=profile_data,
    )
