"""Check queued execution against the actual target approved at confirmation."""

from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import sessionmaker

from src.models import Application, ApplicationStatus, Job, ListingType, User, UserMode
from src.pipelines import application_pipeline
from src.pipelines.quota_selector import QuotaSelector
from src.utils.dates import week_start
from src.utils.status_logger import StatusLogger


@pytest.fixture
def confirmed_application(db_session):
    user = User(
        name="Synthetic Student",
        email="pipeline-test@example.com",
        mode=UserMode.internship,
        weekly_quota=1,
        master_profile={"skills": ["Python"]},
    )
    job = Job(
        title="Python Intern",
        company="Synthetic Pipeline Company",
        description="Python internship with a technical interview.",
        url="https://example.com/jobs/reviewed",
        application_url="https://example.com/jobs/reviewed",
        listing_type=ListingType.internship,
    )
    application = Application(
        user=user,
        job=job,
        status=ApplicationStatus.planned,
        cycle_start=week_start(),
        resume_path="synthetic-approved-resume.pdf",
    )
    db_session.add(application)
    db_session.commit()
    QuotaSelector(db_session).confirm_plan(user.id, [job.id])
    assert application.job_snapshot["target_url"] == job.url
    return application


@pytest.fixture
def pipeline_boundaries(monkeypatch):
    """Prevent every external provider, PDF operation, and browser invocation."""
    mocks = {}
    for name in (
        "WebSearch",
        "ResumeService",
        "CompanyIntelAgent",
        "PrepGuideAgent",
        "ApplicationAgent",
        "ReportGenerator",
    ):
        mocks[name] = MagicMock(name=name)
        monkeypatch.setattr(application_pipeline, name, mocks[name])
    mocks["CompanyIntelAgent"].return_value.research.return_value = {"stage": "unknown"}
    return mocks


def test_changed_actual_target_requires_action_before_resume_or_browser(
    db_session, confirmed_application, pipeline_boundaries
):
    application = confirmed_application
    approved_url = application.job.url
    # Keep application_url unchanged: execution actually uses job.url, and a
    # comparison of application_url alone previously missed this change.
    application.job.url = "https://example.com/jobs/replaced-after-review"
    db_session.commit()
    assert application.job.application_url == approved_url
    assert application.job_snapshot["target_url"] == approved_url

    application_pipeline.process_confirmed_applications(
        [application.id], sessionmaker(bind=db_session.get_bind())
    )

    db_session.expire_all()
    assert application.status == ApplicationStatus.needs_action
    assert "changed after confirmation" in application.failure_reason
    assert application.status_history[-1].status == "needs_action"
    assert application.status_history[-1].reason == application.failure_reason
    assert application.job_snapshot["target_url"] == approved_url
    for name in ("ResumeService", "CompanyIntelAgent", "PrepGuideAgent", "ApplicationAgent"):
        pipeline_boundaries[name].assert_not_called()
    pipeline_boundaries["WebSearch"].return_value.search.assert_not_called()
    pipeline_boundaries["WebSearch"].return_value.close.assert_called_once_with()


def test_unchanged_approved_target_reaches_submission_pipeline(
    db_session, confirmed_application, pipeline_boundaries
):
    application = confirmed_application
    application_id, approved_url = application.id, application.job.url

    def record_synthetic_submission(*_args, db, application_id):
        StatusLogger(db).log(application_id, "applied")
        return {"status": "applied"}

    browser_apply = pipeline_boundaries["ApplicationAgent"].return_value.apply
    browser_apply.side_effect = record_synthetic_submission
    application_pipeline.process_confirmed_applications(
        [application_id], sessionmaker(bind=db_session.get_bind())
    )

    pipeline_boundaries["ResumeService"].return_value.prepare.assert_called_once()
    pipeline_boundaries["CompanyIntelAgent"].return_value.research.assert_called_once()
    pipeline_boundaries["PrepGuideAgent"].return_value.generate.assert_called_once()
    browser_apply.assert_called_once()
    assert browser_apply.call_args.args[0] == approved_url
    assert browser_apply.call_args.kwargs["application_id"] == application_id
    db_session.expire_all()
    assert application.status == ApplicationStatus.applied
    assert application.applied_at is not None
    assert application.failure_reason is None
    assert application.job_snapshot["target_url"] == approved_url
