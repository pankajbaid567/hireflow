"""Keep reviewed weekly drafts eligible, current, and within the user's quota."""

from datetime import datetime, timedelta, timezone
import logging

from sqlalchemy.orm import Session
from sqlalchemy import or_
from src.models.job import Job

from src.models.application import Application, ApplicationStatus
from src.models.user import User
from src.utils.status_logger import StatusLogger
from src.utils.dates import week_start
from src.utils.listings import company_key, company_aliases
from src.api.serializers import job_data

logger = logging.getLogger(__name__)


class QuotaSelector:
    def __init__(self, db: Session):
        self.db = db
        self._submitted_keys = {}

    def _user(self, user_id):
        # Serialize quota changes and confirmations for the same user on
        # PostgreSQL. SQLite ignores FOR UPDATE for isolated local tests.
        user = self.db.query(User).filter(User.id == user_id).with_for_update().first()
        if user is None:
            raise ValueError(f"User {user_id} not found")
        return user

    def _remaining(self, user, start):
        consumed = (
            self.db.query(Application)
            .filter(
                Application.user_id == user.id,
                Application.cycle_start == start,
                Application.status.notin_(
                    [ApplicationStatus.pending, ApplicationStatus.planned]
                ),
            )
            .count()
        )
        return max(0, user.weekly_quota - consumed)

    def _ineligible_reason(self, application, user):
        job = application.job
        if job.is_spam:
            return "listing is marked as spam"
        blocked = (user.master_profile or {}).get("blacklist_companies") or []
        if isinstance(blocked, str):
            blocked = [blocked]
        blacklist = {
            company_key(name) for name in blocked if isinstance(name, str)
        }
        if company_key(job.company or "") in blacklist:
            return "company is blacklisted"
        if user.id not in self._submitted_keys:
            prior_rows = self.db.query(Application).filter(Application.user_id == user.id, or_(Application.applied_at.is_not(None), Application.status.in_([ApplicationStatus.applied, ApplicationStatus.interview, ApplicationStatus.offer]))).all()
            self._submitted_keys[user.id] = {key for prior in prior_rows for key in company_aliases((prior.job_snapshot or {}).get("company") or prior.job.company, user.master_profile)}
        if company_key(job.company) in self._submitted_keys[user.id]:
            return "company already has a submitted application; automatic reapplication is disabled"
        expiry = job.expires_at
        if expiry and expiry.tzinfo is None:
            expiry = expiry.replace(tzinfo=timezone.utc)
        if expiry and expiry < datetime.now(timezone.utc):
            return "listing has expired"
        posted = job.posted_date
        if posted and posted.tzinfo is None:
            posted = posted.replace(tzinfo=timezone.utc)
        if posted and posted < datetime.now(timezone.utc) - timedelta(days=30):
            return "listing has expired"
        if job.listing_type.value != user.mode.value:
            return "listing does not match the selected mode"
        return None

    def generate_weekly_plan(self, user_id: int) -> dict:
        self._submitted_keys.clear()
        user = self._user(user_id)
        start = week_start()
        available = self._remaining(user, start)
        planned_apps = []
        drafts = (
            self.db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.status == ApplicationStatus.planned,
            )
            .order_by(Application.match_score.desc().nullslast(), Application.id)
            .all()
        )
        status_logger = StatusLogger(self.db)
        changed = False
        for app in drafts:
            reason = self._ineligible_reason(app, user)
            if reason or len(planned_apps) >= available:
                status_logger.log(
                    app,
                    ApplicationStatus.pending,
                    f"Removed from weekly plan: {reason or 'weekly quota limit'}",
                    commit=False,
                )
                app.cycle_start = None
                changed = True
                continue
            if app.cycle_start != start:
                app.cycle_start = start
                changed = True
            planned_apps.append(app)

        if len(planned_apps) < available:
            pending = (
                self.db.query(Application)
                .filter(
                    Application.user_id == user_id,
                    Application.status == ApplicationStatus.pending,
                )
                .order_by(Application.match_score.desc().nullslast(), Application.id)
                .all()
            )
            for app in pending:
                if self._ineligible_reason(app, user):
                    continue
                app.cycle_start = start
                status_logger.log(app, ApplicationStatus.planned, commit=False)
                planned_apps.append(app)
                changed = True
                if len(planned_apps) == available:
                    break
        if changed:
            self.db.commit()

        details = [
            {
                "application_id": app.id,
                "job_id": app.job_id,
                **job_data(app.job),
                "role_title": app.job.title,
                "company_name": app.job.company,
                "match_score": app.match_score,
                "skill_gaps": app.skill_gaps,
                "resume_url": (
                    f"/resumes/{user_id}/{app.id}/download" if app.resume_path else None
                ),
                "resume_version": app.resume_version,
                "resume_summary": "Tailored resume will be generated upon confirmation.",
            }
            for app in planned_apps
        ]
        details.sort(key=lambda item: item["match_score"] or 0, reverse=True)
        return {
            "user_id": user_id,
            "quota": user.weekly_quota,
            "confirmation_mode": user.confirmation_mode.value,
            "plan": details,
        }

    def swap_job(self, user_id: int, remove_job_id: int, add_job_id: int) -> dict:
        self._submitted_keys.clear()
        user = self._user(user_id)
        start = week_start()
        app_to_remove = (
            self.db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.job_id == remove_job_id,
                Application.status == ApplicationStatus.planned,
                Application.cycle_start == start,
            )
            .first()
        )
        if app_to_remove is None:
            raise ValueError(
                f"Job {remove_job_id} is not currently planned for user {user_id}"
            )
        if not self._remaining(user, start):
            raise ValueError("The weekly quota is already exhausted")
        app_to_add = (
            self.db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.job_id == add_job_id,
                Application.status == ApplicationStatus.pending,
            )
            .first()
        )
        if app_to_add is None:
            raise ValueError(
                f"Job {add_job_id} is not a valid pending job for user {user_id}"
            )
        reason = self._ineligible_reason(app_to_add, user)
        if reason:
            raise ValueError(f"Replacement {reason}")
        status_logger = StatusLogger(self.db)
        status_logger.log(
            app_to_remove,
            ApplicationStatus.pending,
            "Removed from weekly plan",
            commit=False,
        )
        app_to_remove.cycle_start = None
        app_to_add.cycle_start = start
        status_logger.log(
            app_to_add, ApplicationStatus.planned, "Added to weekly plan", commit=False
        )
        self.db.commit()
        return self.generate_weekly_plan(user_id)

    def confirm_plan(self, user_id: int, confirmed_job_ids: list[int]) -> dict:
        self._submitted_keys.clear()
        if not confirmed_job_ids or len(set(confirmed_job_ids)) != len(
            confirmed_job_ids
        ):
            raise ValueError("Select distinct planned jobs to confirm")
        user = self._user(user_id)
        start = week_start()
        applications = (
            self.db.query(Application)
            .filter(
                Application.user_id == user_id,
                Application.job_id.in_(confirmed_job_ids),
                Application.status == ApplicationStatus.planned,
                Application.cycle_start == start,
            )
            .all()
        )
        if len(applications) != len(confirmed_job_ids):
            missing = set(confirmed_job_ids) - {app.job_id for app in applications}
            raise ValueError(
                f"Some jobs are not currently planned in this weekly cycle: {missing}"
            )
        if len(applications) > self._remaining(user, start):
            raise ValueError("Confirming these jobs exceeds the remaining weekly quota")
        for application in applications:
            reason = self._ineligible_reason(application, user)
            if reason:
                raise ValueError(
                    f"Job {application.job_id} cannot be confirmed: {reason}"
                )
        for application in applications:
            application.job_snapshot = {**job_data(application.job), "company":application.job.company,"role":application.job.title,"description":application.job.description,"company_key":company_key(application.job.company),"target_url":application.job.url}
            StatusLogger(self.db).log(
                application, ApplicationStatus.confirmed, commit=False
            )
        self.db.commit()
        logger.info("Confirmed %s jobs for user %s", len(applications), user_id)
        return {
            "status": "success",
            "message": f"{len(applications)} applications confirmed and queued for resume generation.",
            "confirmed_job_ids": confirmed_job_ids,
        }
