"""Persist state and its audit event in the same transaction."""

from datetime import datetime, timezone

from src.models.application import Application, ApplicationStatus
from src.models.status_event import ApplicationStatusEvent


class StatusLogger:
    def __init__(self, db):
        self.db = db

    def log(
        self, application, status, reason=None, manual_action_url=None, *, commit=True
    ):
        if isinstance(application, int):
            application = self.db.get(Application, application)
        if application is None:
            raise ValueError("Application not found")
        status = ApplicationStatus(status)
        if (
            status in {ApplicationStatus.failed, ApplicationStatus.needs_action}
            and not reason
        ):
            raise ValueError("A failure or manual action requires a reason")
        if application.status == status:
            return application
        application.status = status
        application.failure_reason = (
            reason
            if status in {ApplicationStatus.failed, ApplicationStatus.needs_action}
            else None
        )
        application.manual_action_url = (
            (manual_action_url or application.job.url)
            if status == ApplicationStatus.needs_action
            else None
        )
        if status == ApplicationStatus.applied:
            application.applied_at = datetime.now(timezone.utc)
        self.db.add(
            ApplicationStatusEvent(
                application_id=application.id, status=status.value, reason=reason
            )
        )
        if commit:
            self.db.commit()
        return application

    set_status = log
