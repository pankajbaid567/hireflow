from sqlalchemy import Column, Integer, String, Enum, DateTime, JSON
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.sql import func
from sqlalchemy.orm import relationship
import enum

from src.config.database import Base


class UserMode(str, enum.Enum):
    internship = "internship"
    job = "job"


class ConfirmationMode(str, enum.Enum):
    batch = "batch"
    individual = "individual"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    mode = Column(Enum(UserMode), nullable=False, default=UserMode.job)
    master_profile = Column(JSONB().with_variant(JSON(), "sqlite"), nullable=True)
    weekly_quota = Column(Integer, nullable=False, default=50)
    confirmation_mode = Column(
        Enum(ConfirmationMode), nullable=False, default=ConfirmationMode.batch
    )
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    applications = relationship(
        "Application", back_populates="user", cascade="all, delete-orphan"
    )
    weekly_reports = relationship(
        "WeeklyReport", back_populates="user", cascade="all, delete-orphan"
    )

    def __repr__(self):
        return f"<User(name={self.name}, email={self.email})>"
