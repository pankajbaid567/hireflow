from sqlalchemy import Column, Integer, Text, JSON, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from src.config.database import Base


class Shortlist(Base):
    __tablename__ = "shortlists"

    id = Column(Integer, primary_key=True)
    # Existing operator rows stay unassigned; HTTP never guesses their owner.
    user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    jd_text = Column(Text, nullable=False)
    candidates = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    applicant_count = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
