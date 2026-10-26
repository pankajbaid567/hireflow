"""Private hiring ownership. Revision006 follows005."""
from alembic import op
import sqlalchemy as sa

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table("shortlists") as batch:
        batch.add_column(sa.Column("user_id", sa.Integer(), nullable=True))
        batch.create_foreign_key("fk_shortlists_user_id", "users", ["user_id"], ["id"])
        batch.create_index("ix_shortlists_user_id", ["user_id"])


def downgrade():
    with op.batch_alter_table("shortlists") as batch:
        batch.drop_index("ix_shortlists_user_id")
        batch.drop_constraint("fk_shortlists_user_id", type_="foreignkey")
        batch.drop_column("user_id")
