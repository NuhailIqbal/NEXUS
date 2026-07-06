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
                return
            logger.info("auto-migrate: empty database detected — bootstrapping schema…")
            conn.execute(_SCHEMA_FILE.read_text(encoding="utf-8"))
            n = conn.execute(
                "SELECT count(*) FROM information_schema.tables "
                "WHERE table_schema='public' AND table_type='BASE TABLE'"
            ).fetchone()[0]
            logger.info("auto-migrate: schema bootstrapped — %s tables created", n)
    except Exception as e:  # noqa: BLE001 — never block startup on migration errors
        logger.error("auto-migrate: schema bootstrap failed: %s", e)
