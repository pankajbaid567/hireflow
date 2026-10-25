"""Run the user-confirmed jobs independently, continuing past manual actions."""

import logging

from src.agents.application_agent import ApplicationAgent
from src.agents.company_intel_agent import CompanyIntelAgent
from src.agents.report_generator import ReportGenerator
from src.config.settings import get_settings
from src.models import Application, ApplicationStatus
from src.pipelines.preparation_services import build_resume_service, build_prep_guide_agent
from src.utils.status_logger import StatusLogger
from src.utils.web_search import WebSearch

logger = logging.getLogger(__name__)


def process_confirmed_applications(application_ids, session_factory):
    settings = get_settings()
    users = set()
    with session_factory() as db:
        search = WebSearch()
        try:
            for application_id in application_ids:
                application = db.get(Application, application_id)
                if (
                    application is None
                    or application.status != ApplicationStatus.confirmed
                ):
                    continue
                users.add(application.user_id)
                try:
                    snapshot = application.job_snapshot or {}
                    changed = snapshot and (snapshot.get("target_url", application.job.url) != application.job.url or any(
                        snapshot.get(key) != value
                        for key, value in {
                            "company": application.job.company,
                            "role": application.job.title,
                            "description": application.job.description,
                            "application_url": application.job.application_url or application.job.url,
                        }.items()
                    ))
                    from src.pipelines.quota_selector import QuotaSelector
                    reason = QuotaSelector(db)._ineligible_reason(application, application.user)
                    if changed or reason:
                        StatusLogger(db).log(application, "needs_action", "Listing or eligibility changed after confirmation. Review before applying again." if changed else str(reason))
                        continue
                    build_resume_service(settings).prepare(application, db)
                    try:
                        intel = CompanyIntelAgent(search).research(
                            application.job.company
                        )
                        build_prep_guide_agent(search_client=search, settings=settings).generate(
                            application,
                            db,
                            company_stage=intel["stage"],
                            company_intel=intel,
                        )
                    except Exception:
                        db.rollback()
                        logger.exception(
                            "Prep guide unavailable for application %s", application_id
                        )
                    profile = {
                        **(application.user.master_profile or {}),
                        "name": application.user.name,
                        "email": application.user.email,
                    }
                    ApplicationAgent(
                        timeout_ms=settings.application_timeout_ms,
                        headless=settings.browser_headless,
                    ).apply(
                        application.job.url,
                        application.resume_path,
                        profile,
                        application.job.description or "",
                        db=db,
                        application_id=application.id,
                    )
                except Exception as exc:
                    db.rollback()
                    StatusLogger(db).log(
                        application, "failed", f"Application preparation failed: {exc}"
                    )
            for user_id in users:
                try:
                    ReportGenerator(db).generate(user_id)
                except Exception:
                    db.rollback()
                    logger.exception("Weekly report unavailable for user %s", user_id)
        finally:
            search.close()
