from sqlalchemy import Column, Integer, Text, ForeignKey, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship

from src.config.database import Base


class PrepGuide(Base):
    __tablename__ = "prep_guides"

    id = Column(Integer, primary_key=True, index=True)
    application_id = Column(
        Integer,
        ForeignKey("applications.id", ondelete="CASCADE"),
        nullable=False,
        unique=True,
        index=True,
    )

    content = Column(Text, nullable=True)  # Full text or markdown of the prep guide
    structured_data = Column(
        JSONB().with_variant(JSON(), "sqlite"), nullable=True
    )  # E.g., specific interview questions, topics
    company_intel = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    application = relationship("Application", back_populates="prep_guide")

    def __repr__(self):
        return f"<PrepGuide(application_id={self.application_id})>"
