from sqlalchemy import Column, Integer, String, Text, Boolean, Float, DateTime, Enum
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

    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    applications = relationship(
        "Application", back_populates="job", cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<Job(title={self.title}, company={self.company})>"
