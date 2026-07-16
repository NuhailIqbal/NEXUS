"""
Auto-migration: bootstrap the database schema on startup.

On app start, if the target PostgreSQL database is empty (no `public.users`
table), the full schema in `schema.sql` is executed automatically — so
pointing the backend at a fresh/empty database self-provisions every table,
index, function and trigger. If the schema already exists, this is a no-op.

This handles *structure* only (tables). Data is migrated separately.
"""
import logging
from pathlib import Path

import psycopg

from config import settings

# Use uvicorn's logger so bootstrap messages appear in the server log output.
logger = logging.getLogger("uvicorn.error")

_SCHEMA_FILE = Path(__file__).resolve().parent / "schema.sql"


def bootstrap_schema() -> None:
    """Create all tables from schema.sql if the database is empty."""
    if not settings.database_url:
        logger.warning("auto-migrate: DATABASE_URL not set — skipping schema bootstrap")
        return
    if not _SCHEMA_FILE.exists():
        logger.warning("auto-migrate: schema.sql not found at %s — skipping", _SCHEMA_FILE)
        return

    try:
        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            exists = conn.execute("SELECT to_regclass('public.users')").fetchone()[0]
            if exists:
                logger.info("auto-migrate: schema already present — skipping bootstrap")
            else:
                logger.info("auto-migrate: empty database detected — bootstrapping schema…")
                conn.execute(_SCHEMA_FILE.read_text(encoding="utf-8"))
                n = conn.execute(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_type='BASE TABLE'"
                ).fetchone()[0]
                logger.info("auto-migrate: schema bootstrapped — %s tables created", n)
            # Always apply incremental, idempotent column additions so existing
            # (already-provisioned) databases pick up new fields on deploy.
            _ensure_columns(conn)
    except Exception as e:  # noqa: BLE001 — never block startup on migration errors
        logger.error("auto-migrate: schema bootstrap failed: %s", e)


def _ensure_columns(conn) -> None:
    """Idempotent ALTERs for columns added after initial provisioning."""
    statements = [
        'ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS qualified boolean DEFAULT false',
        'ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS transferred_to text',
        'ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS transfer_number text',
        'ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS transfer_tool_id text',
        'ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS monthly_cost numeric DEFAULT 0',
        'ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS stripe_session_id text',
        # Wallet: dollar balance + transaction ledger.
        'ALTER TABLE public.billing ADD COLUMN IF NOT EXISTS balance numeric(10,2) DEFAULT 0',
        '''CREATE TABLE IF NOT EXISTS public.wallet_transactions (
            id uuid DEFAULT gen_random_uuid() NOT NULL,
            user_id uuid NOT NULL,
            kind text NOT NULL,
            amount numeric(10,2) NOT NULL,
            balance_after numeric(10,2),
            description text,
            stripe_session_id text,
            ref_id text,
            created_at timestamp with time zone DEFAULT now() NOT NULL
        )''',
        '''CREATE UNIQUE INDEX IF NOT EXISTS wallet_transactions_stripe_session_id_key
            ON public.wallet_transactions (stripe_session_id) WHERE stripe_session_id IS NOT NULL''',
        '''CREATE INDEX IF NOT EXISTS wallet_transactions_user_id_idx
            ON public.wallet_transactions (user_id, created_at DESC)''',
        'ALTER TABLE public.billing ALTER COLUMN rate_per_minute SET DEFAULT 0.10',
        # Flat pricing: bump any legacy sub-$0.10 client to the current $0.10/min rate.
        'UPDATE public.billing SET rate_per_minute = 0.10 WHERE rate_per_minute IS NULL OR rate_per_minute < 0.10',
    ]
    for stmt in statements:
        try:
            conn.execute(stmt)
        except Exception as e:  # noqa: BLE001
            logger.warning("auto-migrate: column ensure skipped (%s): %s", stmt.split("EXISTS", 1)[-1].strip(), e)
