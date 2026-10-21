from sqlalchemy import Column, Integer, Text, JSON, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func

from src.config.database import Base


class Shortlist(Base):
    __tablename__ = "shortlists"

    id = Column(Integer, primary_key=True)
    jd_text = Column(Text, nullable=False)
    candidates = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=False)
    applicant_count = Column(Integer, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
