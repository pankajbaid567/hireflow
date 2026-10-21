from sqlalchemy import (
    Column,
    Integer,
    Date,
    ForeignKey,
    DateTime,
    JSON,
    String,
    Float,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from src.config.database import Base


class WeeklyReport(Base):
    __tablename__ = "weekly_reports"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "week_start_date", name="uq_weekly_report_user_week"
        ),
    )

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(
        Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )

    week_start_date = Column(Date, nullable=False)
    metrics = Column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=False
    )  # e.g., jobs_applied, interviews_secured, etc.
    content = Column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )  # Could be sections of the report text or summary
    applied_count = Column(Integer, nullable=False, default=0)
    avg_match_score = Column(Float, nullable=False, default=0)
    html_path = Column(String)
    email_sent_at = Column(DateTime(timezone=True))
    email_failure_reason = Column(String)

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    user = relationship("User", back_populates="weekly_reports")

    def __repr__(self):
        return (
            f"<WeeklyReport(user_id={self.user_id}, week_start={self.week_start_date})>"
        )
