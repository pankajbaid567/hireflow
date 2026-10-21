from sqlalchemy import Column, Integer, String, ForeignKey, DateTime
from sqlalchemy.sql import func

from src.config.database import Base


class ApplicationStatusEvent(Base):
    __tablename__ = "application_status_events"

    id = Column(Integer, primary_key=True)
    application_id = Column(
        Integer,
        ForeignKey("applications.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    status = Column(String, nullable=False)
    reason = Column(String)
    created_at = Column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
