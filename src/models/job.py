from sqlalchemy import Column, Integer, String, Text, Boolean, Float, DateTime, Enum, JSON, event, inspect
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
import enum

from src.config.database import Base


class ListingType(str, enum.Enum):
    internship = "internship"
    job = "job"


class Job(Base):
    __tablename__ = "jobs"

    id = Column(Integer, primary_key=True, index=True)
    title = Column(String, nullable=False)
    company = Column(String, nullable=False)
    location = Column(String, nullable=True)
    description = Column(Text, nullable=True)
    url = Column(String, unique=True, index=True, nullable=False)
    posted_date = Column(DateTime(timezone=True), nullable=True)

    listing_type = Column(Enum(ListingType), nullable=False, default=ListingType.job)
    is_spam = Column(Boolean, nullable=False, default=False)
    spam_confidence = Column(Float, nullable=True)
    canonical_url = Column(Text, nullable=True)
    application_url = Column(Text, nullable=True)
    source = Column(String, nullable=True)
    required_skills = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    required_experience = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    expires_at = Column(DateTime(timezone=True), nullable=True)
    selection_process = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    compensation = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    provenance = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    company_key = Column(String, nullable=True, index=True)
    quality_reason = Column(Text, nullable=True)
    quality_method = Column(String, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    applications = relationship(
        "Application", back_populates="job", cascade="all, delete-orphan"
    )

    def __init__(self, **kwargs):
        from src.utils.listings import listing_fields

        if kwargs.get("url"):
            facts = listing_fields(kwargs)
            facts.update(kwargs)
            kwargs = facts
        super().__init__(**kwargs)

    def __repr__(self):
        return f"<Job(title={self.title}, company={self.company})>"


@event.listens_for(Job, "before_update")
def refresh_listing_evidence(mapper, connection, target):
    state = inspect(target)
    changed = {field for field in ("title", "company", "url", "description", "location", "posted_date", "expires_at") if state.attrs[field].history.has_changes()}
    if changed:
        from src.utils.listings import enrich_job
        if "description" in changed:
            target.compensation = None
        enrich_job(target)
