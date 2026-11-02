"""One application per (user, job). Revision007 follows006. Audit F-018.

The Worker schema already enforces this; the Python/Postgres path relied on a read-then-insert
that two concurrent scoring runs could both pass. Pre-existing duplicates keep the earliest row
(lowest id, which is the one that holds the real history); later duplicates are removed first so the
constraint can be created. Their status events and prep guides cascade with them.
"""
from alembic import op

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None

NAME = "uq_applications_user_job"


def upgrade():
    op.execute(
        "DELETE FROM applications a USING applications b "
        "WHERE a.user_id = b.user_id AND a.job_id = b.job_id AND a.id > b.id"
        if op.get_bind().dialect.name == "postgresql"
        else "DELETE FROM applications WHERE id NOT IN "
        "(SELECT MIN(id) FROM applications GROUP BY user_id, job_id)"
    )
    with op.batch_alter_table("applications") as batch:
        batch.create_unique_constraint(NAME, ["user_id", "job_id"])


def downgrade():
    with op.batch_alter_table("applications") as batch:
        batch.drop_constraint(NAME, type_="unique")
