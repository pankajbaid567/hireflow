from src.models import Base


def test_tables_exist():
    tables = Base.metadata.tables.keys()
    assert "users" in tables
    assert "jobs" in tables
    assert "applications" in tables
    assert "prep_guides" in tables
    assert "weekly_reports" in tables
    assert "application_status_events" in tables
    assert "shortlists" in tables
    assert {"auth_sessions", "account_recovery_keys", "account_attempts"}.issubset(
        tables
    )
    assert len(tables) == 10


def test_users_table_columns():
    user_columns = Base.metadata.tables["users"].columns.keys()
    expected = [
        "id",
        "name",
        "email",
        "mode",
        "master_profile",
        "weekly_quota",
        "confirmation_mode",
        "created_at",
    ]
    for col in expected:
        assert col in user_columns


def test_jobs_table_columns():
    job_columns = Base.metadata.tables["jobs"].columns.keys()
    expected = [
        "id",
        "title",
        "company",
        "location",
        "description",
        "url",
        "posted_date",
        "listing_type",
        "is_spam",
        "spam_confidence",
        "created_at",
    ]
    for col in expected:
        assert col in job_columns


def test_applications_table_columns():
    app_columns = Base.metadata.tables["applications"].columns.keys()
    expected = [
        "id",
        "user_id",
        "job_id",
        "match_score",
        "skill_gaps",
        "resume_path",
        "status",
        "created_at",
        "updated_at",
    ]
    for col in expected:
        assert col in app_columns


def test_prep_guides_table_columns():
    pg_columns = Base.metadata.tables["prep_guides"].columns.keys()
    expected = [
        "id",
        "application_id",
        "content",
        "structured_data",
        "created_at",
        "updated_at",
    ]
    for col in expected:
        assert col in pg_columns


def test_weekly_reports_table_columns():
    wr_columns = Base.metadata.tables["weekly_reports"].columns.keys()
    expected = ["id", "user_id", "week_start_date", "metrics", "content", "created_at"]
    for col in expected:
        assert col in wr_columns
