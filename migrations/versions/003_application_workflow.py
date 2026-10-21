"""Application workflow, status history, preparation, reports and shortlists.

Revision ID: 003
Revises: 002
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None

OLD_STATUSES = ("pending", "applied", "rejected", "interview", "offer")
NEW_STATUSES = ("planned", "confirmed", "applying", "failed", "needs_action")


def json_type():
    return sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade():
    bind = op.get_bind()
    if not op.get_context().as_sql:
        duplicate = bind.execute(sa.text("""
            SELECT user_id, week_start_date FROM weekly_reports
            GROUP BY user_id, week_start_date HAVING COUNT(*) > 1 LIMIT 1
        """)).first()
        if duplicate:
            raise RuntimeError(
                "Reconcile duplicate weekly_reports for each user/week before migration 003; "
                "no report rows have been discarded."
            )
    if bind.dialect.name == "postgresql":
        # PostgreSQL requires the added labels to commit before they can be used.
        # Existing labels and application rows are preserved.
        with op.get_context().autocommit_block():
            for status in NEW_STATUSES:
                op.execute(f"ALTER TYPE applicationstatus ADD VALUE IF NOT EXISTS '{status}'")

    with op.batch_alter_table("applications") as batch:
        if bind.dialect.name != "postgresql":
            batch.alter_column(
                "status",
                existing_type=sa.Enum(*OLD_STATUSES, name="applicationstatus"),
                type_=sa.Enum(*OLD_STATUSES, *NEW_STATUSES, name="applicationstatus"),
                existing_nullable=False,
            )
        batch.add_column(sa.Column("resume_version", sa.Integer(), nullable=True))
        batch.add_column(sa.Column("failure_reason", sa.String(), nullable=True))
        batch.add_column(sa.Column("manual_action_url", sa.String(), nullable=True))
        batch.add_column(sa.Column("applied_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("cycle_start", sa.Date(), nullable=True))
        batch.add_column(sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"))
        batch.create_index("ix_applications_cycle_start", ["cycle_start"], unique=False)

    op.create_table(
        "application_status_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("application_id", sa.Integer(), sa.ForeignKey("applications.id", ondelete="CASCADE"), nullable=False),
        sa.Column("status", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.current_timestamp()),
    )
    op.create_index("ix_application_status_events_application_id", "application_status_events", ["application_id"])
    # Record a starting point for applications created before status logging existed.
    op.execute(sa.text("""
        INSERT INTO application_status_events (application_id, status, reason, created_at)
        SELECT id, CAST(status AS VARCHAR), 'Existing application imported during migration',
               COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        FROM applications
    """))
    op.execute(sa.text("""
        UPDATE applications SET applied_at = COALESCE(updated_at, created_at, CURRENT_TIMESTAMP)
        WHERE status = 'applied'
    """))

    op.add_column("prep_guides", sa.Column("company_intel", json_type(), nullable=True))
    op.create_table(
        "shortlists",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("jd_text", sa.Text(), nullable=False),
        sa.Column("candidates", json_type(), nullable=False),
        sa.Column("applicant_count", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.current_timestamp()),
    )
    with op.batch_alter_table("weekly_reports") as batch:
        batch.add_column(sa.Column("applied_count", sa.Integer(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("avg_match_score", sa.Float(), nullable=False, server_default="0"))
        batch.add_column(sa.Column("html_path", sa.String(), nullable=True))
        batch.add_column(sa.Column("email_sent_at", sa.DateTime(timezone=True), nullable=True))
        batch.add_column(sa.Column("email_failure_reason", sa.String(), nullable=True))
        batch.create_unique_constraint("uq_weekly_report_user_week", ["user_id", "week_start_date"])


def downgrade():
    bind = op.get_bind()
    with op.batch_alter_table("weekly_reports") as batch:
        batch.drop_constraint("uq_weekly_report_user_week", type_="unique")
        for name in ("email_failure_reason", "email_sent_at", "html_path", "avg_match_score", "applied_count"):
            batch.drop_column(name)
    op.drop_table("shortlists")
    with op.batch_alter_table("prep_guides") as batch:
        batch.drop_column("company_intel")
    op.drop_index("ix_application_status_events_application_id", table_name="application_status_events")
    op.drop_table("application_status_events")
    op.execute(sa.text("""
        UPDATE applications SET status = 'pending'
        WHERE CAST(status AS VARCHAR) IN ('planned', 'confirmed', 'applying', 'failed', 'needs_action')
    """))
    with op.batch_alter_table("applications") as batch:
        batch.drop_index("ix_applications_cycle_start")
        for name in ("attempts", "cycle_start", "applied_at", "manual_action_url", "failure_reason", "resume_version"):
            batch.drop_column(name)
        if bind.dialect.name != "postgresql":
            batch.alter_column(
                "status",
                existing_type=sa.Enum(*OLD_STATUSES, *NEW_STATUSES, name="applicationstatus"),
                type_=sa.Enum(*OLD_STATUSES, name="applicationstatus"),
                existing_nullable=False,
            )
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TYPE applicationstatus RENAME TO applicationstatus_new")
        sa.Enum(*OLD_STATUSES, name="applicationstatus").create(bind)
        op.execute("ALTER TABLE applications ALTER COLUMN status DROP DEFAULT")
        op.execute("ALTER TABLE applications ALTER COLUMN status TYPE applicationstatus USING status::text::applicationstatus")
        op.execute("DROP TYPE applicationstatus_new")
