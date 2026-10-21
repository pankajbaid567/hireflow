"""Verify plan quotas and confirmation against isolated, real database rows."""

from datetime import datetime, timedelta, timezone

import pytest

from src.agents.report_generator import ReportGenerator
from src.models import Application, ApplicationStatus, Job, ListingType, User, UserMode
from src.pipelines.quota_selector import QuotaSelector
from src.utils.dates import week_start


def make_user(db, quota=3):
    user = User(
        name="Student",
        email="student@example.com",
        mode=UserMode.internship,
        weekly_quota=quota,
        master_profile={"blacklist_companies": ["BadCo"]},
    )
    db.add(user)
    db.commit()
    return user


def make_app(db, user, score=0.8, status="pending", cycle=None, **job_fields):
    index = db.query(Job).count() + 1
    fields = {
        "title": f"Role {index}",
        "company": "GoodCo",
        "url": f"https://jobs.example.com/{index}",
        "description": "Python Docker",
        "listing_type": ListingType.internship,
        "posted_date": datetime.now(timezone.utc) - timedelta(days=5),
    }
    job = Job(**{**fields, **job_fields})
    app = Application(
        user=user,
        job=job,
        match_score=score,
        status=ApplicationStatus(status),
        cycle_start=cycle,
    )
    db.add(app)
    db.commit()
    return app


def invalidate(app, kind):
    if kind == "expired":
        app.job.posted_date = datetime.now(timezone.utc) - timedelta(days=40)
    elif kind == "spam":
        app.job.is_spam = True
    elif kind == "blacklist":
        app.job.company = "bAdCo"
    else:
        app.job.listing_type = ListingType.job


def test_selects_top_n_and_read_does_not_duplicate_audit(db_session):
    user = make_user(db_session, quota=2)
    apps = [make_app(db_session, user, score) for score in (0.7, 0.9, 0.8)]
    selector = QuotaSelector(db_session)
    plan = selector.generate_weekly_plan(user.id)
    assert [item["application_id"] for item in plan["plan"]] == [apps[1].id, apps[2].id]
    assert apps[0].status == ApplicationStatus.pending
    assert all(app.cycle_start == week_start() for app in apps[1:])
    assert selector.generate_weekly_plan(user.id)["plan"] == plan["plan"]
    assert [event.status for event in apps[1].status_history] == ["planned"]


def test_pending_candidates_filter_expired_spam_blacklist_and_mode(db_session):
    user = make_user(db_session, quota=2)
    for fields in (
        {"company": "BadCo"},
        {"posted_date": datetime.now(timezone.utc) - timedelta(days=40)},
        {"is_spam": True},
        {"listing_type": ListingType.job},
    ):
        make_app(db_session, user, score=0.99, **fields)
    good = [make_app(db_session, user, score) for score in (0.8, 0.7)]
    plan = QuotaSelector(db_session).generate_weekly_plan(user.id)
    assert [item["application_id"] for item in plan["plan"]] == [app.id for app in good]


@pytest.mark.parametrize("kind", ["expired", "spam", "blacklist", "mode"])
def test_existing_draft_is_revalidated_with_audit(db_session, kind):
    user = make_user(db_session, quota=1)
    stale = make_app(db_session, user, 0.99, "planned", week_start())
    invalidate(stale, kind)
    replacement = make_app(db_session, user)
    plan = QuotaSelector(db_session).generate_weekly_plan(user.id)
    assert [item["application_id"] for item in plan["plan"]] == [replacement.id]
    assert stale.status == ApplicationStatus.pending and stale.cycle_start is None
    assert stale.status_history[-1].status == "pending"
    assert "Removed from weekly plan" in stale.status_history[-1].reason


def test_prior_week_draft_rolls_forward_and_is_in_current_report(db_session, tmp_path):
    user = make_user(db_session, quota=1)
    app = make_app(
        db_session, user, status="planned", cycle=week_start() - timedelta(days=7)
    )
    selector = QuotaSelector(db_session)
    assert selector.generate_weekly_plan(user.id)["plan"][0]["application_id"] == app.id
    assert app.cycle_start == week_start()
    selector.confirm_plan(user.id, [app.job_id])
    report = ReportGenerator(db_session, storage_path=tmp_path).generate(user.id)
    assert report["metrics"]["application_count"] == 1
    assert report["content"]["applications"][0]["id"] == app.id


def test_lowered_quota_demotes_lowest_draft_and_clears_cycle(db_session):
    user = make_user(db_session, quota=2)
    best, extra = [make_app(db_session, user, score) for score in (0.9, 0.8)]
    selector = QuotaSelector(db_session)
    selector.generate_weekly_plan(user.id)
    user.weekly_quota = 1
    db_session.commit()
    plan = selector.generate_weekly_plan(user.id)
    assert [item["application_id"] for item in plan["plan"]] == [best.id]
    assert extra.status == ApplicationStatus.pending and extra.cycle_start is None
    assert "quota" in extra.status_history[-1].reason


@pytest.mark.parametrize(
    "status",
    [
        "confirmed",
        "applying",
        "applied",
        "failed",
        "needs_action",
        "rejected",
        "interview",
        "offer",
    ],
)
def test_attempted_states_consume_current_week_quota(db_session, status):
    user = make_user(db_session, quota=2)
    used = make_app(db_session, user, 0.99, status, week_start())
    best = make_app(db_session, user, 0.8)
    later = make_app(db_session, user, 0.7)
    plan = QuotaSelector(db_session).generate_weekly_plan(user.id)
    assert [item["application_id"] for item in plan["plan"]] == [best.id]
    assert used.status.value == status and later.status == ApplicationStatus.pending


def test_prior_cycle_applied_is_not_reselected_or_counted_twice(db_session):
    user = make_user(db_session, quota=1)
    applied = make_app(db_session, user, 1, "applied", week_start() - timedelta(days=7))
    pending = make_app(db_session, user)
    assert (
        QuotaSelector(db_session).generate_weekly_plan(user.id)["plan"][0][
            "application_id"
        ]
        == pending.id
    )
    assert (
        applied.status == ApplicationStatus.applied
        and applied.cycle_start != week_start()
    )


def test_exhausted_quota_removes_drafts_without_selecting_more(db_session):
    user = make_user(db_session, quota=1)
    make_app(db_session, user, status="failed", cycle=week_start())
    draft = make_app(db_session, user, status="planned", cycle=week_start())
    make_app(db_session, user, 0.99)
    assert QuotaSelector(db_session).generate_weekly_plan(user.id)["plan"] == []
    assert draft.status == ApplicationStatus.pending and draft.cycle_start is None
    assert "quota" in draft.status_history[-1].reason


def test_confirm_records_state_and_refuses_repeat(db_session):
    user = make_user(db_session, quota=1)
    app = make_app(db_session, user, status="planned", cycle=week_start())
    selector = QuotaSelector(db_session)
    assert selector.confirm_plan(user.id, [app.job_id])["status"] == "success"
    assert app.status == ApplicationStatus.confirmed
    assert app.status_history[-1].status == "confirmed"
    with pytest.raises(ValueError, match="not currently planned"):
        selector.confirm_plan(user.id, [app.job_id])


def test_confirm_prior_week_requires_new_review(db_session):
    user = make_user(db_session)
    app = make_app(
        db_session, user, status="planned", cycle=week_start() - timedelta(days=7)
    )
    with pytest.raises(ValueError, match="weekly cycle"):
        QuotaSelector(db_session).confirm_plan(user.id, [app.job_id])
    assert app.status == ApplicationStatus.planned and app.status_history == []


@pytest.mark.parametrize(
    "status", ["confirmed", "applying", "applied", "failed", "needs_action"]
)
def test_confirm_checks_quota_against_all_current_attempts(db_session, status):
    user = make_user(db_session, quota=1)
    make_app(db_session, user, status=status, cycle=week_start())
    app = make_app(db_session, user, status="planned", cycle=week_start())
    with pytest.raises(ValueError, match="weekly quota"):
        QuotaSelector(db_session).confirm_plan(user.id, [app.job_id])
    assert app.status == ApplicationStatus.planned


def test_confirmation_is_atomic_when_quota_was_lowered(db_session):
    user = make_user(db_session, quota=1)
    apps = [
        make_app(db_session, user, status="planned", cycle=week_start())
        for _ in range(2)
    ]
    with pytest.raises(ValueError, match="weekly quota"):
        QuotaSelector(db_session).confirm_plan(user.id, [app.job_id for app in apps])
    assert all(app.status == ApplicationStatus.planned for app in apps)


@pytest.mark.parametrize("kind", ["expired", "spam", "blacklist", "mode"])
def test_confirm_checks_changes_since_preview(db_session, kind):
    user = make_user(db_session)
    app = make_app(db_session, user, status="planned", cycle=week_start())
    invalidate(app, kind)
    db_session.commit()
    with pytest.raises(ValueError, match="cannot be confirmed"):
        QuotaSelector(db_session).confirm_plan(user.id, [app.job_id])
    assert app.status == ApplicationStatus.planned


@pytest.mark.parametrize("ids", [[], [1, 1], [9999]])
def test_invalid_selection_does_not_change_state(db_session, ids):
    user = make_user(db_session)
    app = make_app(db_session, user, status="planned", cycle=week_start())
    with pytest.raises(ValueError):
        QuotaSelector(db_session).confirm_plan(user.id, ids)
    assert app.status == ApplicationStatus.planned


def test_swap_preserves_choice_and_records_both_statuses(db_session):
    user = make_user(db_session, quota=1)
    original = make_app(db_session, user, 0.9, "planned", week_start())
    replacement = make_app(db_session, user, 0.8)
    plan = QuotaSelector(db_session).swap_job(
        user.id, original.job_id, replacement.job_id
    )
    assert [item["application_id"] for item in plan["plan"]] == [replacement.id]
    assert original.status == ApplicationStatus.pending and original.cycle_start is None
    assert original.status_history[-1].reason == "Removed from weekly plan"
    assert replacement.status_history[-1].reason == "Added to weekly plan"


@pytest.mark.parametrize("kind", ["expired", "spam", "blacklist", "mode"])
def test_swap_refuses_invalid_replacement_without_mutation(db_session, kind):
    user = make_user(db_session, quota=1)
    original = make_app(db_session, user, status="planned", cycle=week_start())
    replacement = make_app(db_session, user)
    invalidate(replacement, kind)
    db_session.commit()
    with pytest.raises(ValueError, match="Replacement"):
        QuotaSelector(db_session).swap_job(user.id, original.job_id, replacement.job_id)
    assert (
        original.status == ApplicationStatus.planned
        and replacement.status == ApplicationStatus.pending
    )


def test_unknown_user_has_clean_error(db_session):
    with pytest.raises(ValueError, match="not found"):
        QuotaSelector(db_session).generate_weekly_plan(9999)
