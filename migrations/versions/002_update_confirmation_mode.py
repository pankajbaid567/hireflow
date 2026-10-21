"""update_confirmation_mode

Revision ID: 002
Revises: 001
Create Date: 2026-07-06 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "002"
down_revision: Union[str, Sequence[str], None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


old_confirmation_mode = sa.Enum("manual", "auto", name="confirmationmode")
new_confirmation_mode = sa.Enum("batch", "individual", name="confirmationmode")


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        op.execute("UPDATE users SET confirmation_mode = CASE WHEN confirmation_mode = 'auto' THEN 'individual' ELSE 'batch' END")
        with op.batch_alter_table("users") as batch:
            batch.alter_column("confirmation_mode", existing_type=old_confirmation_mode, type_=new_confirmation_mode, existing_nullable=False)
        return

    op.execute("ALTER TYPE confirmationmode RENAME TO confirmationmode_old")
    new_confirmation_mode.create(bind, checkfirst=False)
    op.execute("ALTER TABLE users ALTER COLUMN confirmation_mode DROP DEFAULT")
    op.execute(
        """
        ALTER TABLE users
        ALTER COLUMN confirmation_mode TYPE confirmationmode
        USING CASE
            WHEN confirmation_mode::text = 'auto' THEN 'individual'::confirmationmode
            ELSE 'batch'::confirmationmode
        END
        """
    )
    op.execute("ALTER TABLE users ALTER COLUMN confirmation_mode SET DEFAULT 'batch'")
    op.execute("DROP TYPE confirmationmode_old")


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        op.execute("UPDATE users SET confirmation_mode = CASE WHEN confirmation_mode = 'individual' THEN 'auto' ELSE 'manual' END")
        with op.batch_alter_table("users") as batch:
            batch.alter_column("confirmation_mode", existing_type=new_confirmation_mode, type_=old_confirmation_mode, existing_nullable=False)
        return

    op.execute("ALTER TYPE confirmationmode RENAME TO confirmationmode_old")
    old_confirmation_mode.create(bind, checkfirst=False)
    op.execute("ALTER TABLE users ALTER COLUMN confirmation_mode DROP DEFAULT")
    op.execute(
        """
        ALTER TABLE users
        ALTER COLUMN confirmation_mode TYPE confirmationmode
        USING CASE
            WHEN confirmation_mode::text = 'individual' THEN 'auto'::confirmationmode
            ELSE 'manual'::confirmationmode
        END
        """
    )
    op.execute("ALTER TABLE users ALTER COLUMN confirmation_mode SET DEFAULT 'manual'")
    op.execute("DROP TYPE confirmationmode_old")
