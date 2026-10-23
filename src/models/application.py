from sqlalchemy import (
    Column,
    Integer,
    String,
    Float,
    ForeignKey,
    DateTime,
    Enum,
    JSON,
    Date,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
import enum

from src.config.database import Base


class ApplicationStatus(str, enum.Enum):
    pending = "pending"
    planned = "planned"
    confirmed = "confirmed"
    applying = "applying"
    applied = "applied"
    failed = "failed"
    needs_action = "needs_action"
    rejected = "rejected"
    interview = "interview"
    offer = "offer"


class Application(Base):
    __tablename__ = "applications"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    job_id = Column(
        Integer, ForeignKey("jobs.id", ondelete="CASCADE"), nullable=False, index=True
    )

    match_score = Column(Float, nullable=True)
    job_snapshot = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    skill_gaps = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    resume_path = Column(String, nullable=True)
    resume_version = Column(Integer, nullable=True)
    status = Column(
        Enum(ApplicationStatus), nullable=False, default=ApplicationStatus.pending
    )
    failure_reason = Column(String, nullable=True)
    manual_action_url = Column(String, nullable=True)
    applied_at = Column(DateTime(timezone=True), nullable=True)
    cycle_start = Column(Date, nullable=True, index=True)
    attempts = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    user = relationship("User", back_populates="applications")
    job = relationship("Job", back_populates="applications")
    prep_guide = relationship(
        "PrepGuide",
        back_populates="application",
        uselist=False,
        cascade="all, delete-orphan",
    )
    status_history = relationship(
        "ApplicationStatusEvent",
        cascade="all, delete-orphan",
        order_by="ApplicationStatusEvent.id",
    )

    def __repr__(self):
        return f"<Application(user_id={self.user_id}, job_id={self.job_id}, status={self.status})>"
