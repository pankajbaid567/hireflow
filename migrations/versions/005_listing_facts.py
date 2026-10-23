"""Evidence-backed listing fields.

Revision ID: 005
Revises: 004
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("applications", sa.Column("job_snapshot", JSONB().with_variant(sa.JSON(), "sqlite"), nullable=True))
    for name in ("canonical_url", "application_url", "quality_reason"):
        op.add_column("jobs", sa.Column(name, sa.Text(), nullable=True))
    for name in ("source", "company_key", "quality_method"):
        op.add_column("jobs", sa.Column(name, sa.String(), nullable=True))
    for name in ("required_skills", "required_experience", "selection_process", "compensation", "provenance"):
        op.add_column("jobs", sa.Column(name, JSONB().with_variant(sa.JSON(), "sqlite"), nullable=True))
    op.add_column("jobs", sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True))
    op.create_index("ix_jobs_company_key", "jobs", ["company_key"])
    op.execute("UPDATE jobs SET canonical_url=url, application_url=url")


def downgrade():
    op.drop_column("applications", "job_snapshot")
    op.drop_index("ix_jobs_company_key", table_name="jobs")
    with op.batch_alter_table("jobs") as batch:
        for name in ("canonical_url", "application_url", "quality_reason", "source", "company_key", "quality_method", "required_skills", "required_experience", "selection_process", "compensation", "provenance", "expires_at"):
            batch.drop_column(name)
