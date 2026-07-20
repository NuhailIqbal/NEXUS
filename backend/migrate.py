"""
Auto-migration: bootstrap AND keep the database schema in sync on startup.

On app start:
  1. If the target PostgreSQL database is empty (no `public.users` table), the
     full `schema.sql` is executed — a fresh/empty database self-provisions
     every table, index, function and trigger.
  2. On EVERY start, `schema.sql` is parsed and any missing table/column is
     added to the live database automatically (idempotent). This makes
     `schema.sql` the single source of truth: just add a column to a
     `CREATE TABLE` there and it appears in existing databases on next boot —
     no hand-written `ALTER TABLE` needed.
  3. A short list of non-column tweaks (default changes, data back-fills,
     indexes) runs afterwards in `_ensure_columns`.

This handles *structure* only (adds tables/columns). It never drops or
renames — destructive changes still need a manual migration.
"""
import logging
import re
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

    schema_sql = _SCHEMA_FILE.read_text(encoding="utf-8")
    try:
        with psycopg.connect(settings.database_url, autocommit=True) as conn:
            exists = conn.execute("SELECT to_regclass('public.users')").fetchone()[0]
            if exists:
                logger.info("auto-migrate: schema already present — checking for new columns…")
            else:
                logger.info("auto-migrate: empty database detected — bootstrapping schema…")
                conn.execute(schema_sql)
                n = conn.execute(
                    "SELECT count(*) FROM information_schema.tables "
                    "WHERE table_schema='public' AND table_type='BASE TABLE'"
                ).fetchone()[0]
                logger.info("auto-migrate: schema bootstrapped — %s tables created", n)
            # Auto-sync: add any table/column defined in schema.sql that the live
            # database is missing (idempotent — the whole point of this module).
            _sync_columns_from_schema(conn, schema_sql)
            # Non-column tweaks: default changes, data back-fills, indexes.
            _ensure_columns(conn)
    except Exception as e:  # noqa: BLE001 — never block startup on migration errors
        logger.error("auto-migrate: schema bootstrap failed: %s", e)


# Matches each `CREATE TABLE [IF NOT EXISTS] public.<name> ( <body> \n);` block.
# Non-greedy body ends at the first line that is exactly `);` (the pg_dump-style
# table terminator); column types like numeric(10,2) never end that way.
_TABLE_RE = re.compile(
    r"CREATE TABLE(?:\s+IF NOT EXISTS)?\s+public\.(\w+)\s*\((.*?)\n\);",
    re.DOTALL | re.IGNORECASE,
)

# A body line that is a table constraint, not a column (skip these).
_CONSTRAINT_START = re.compile(r"^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|EXCLUDE)\b", re.IGNORECASE)


def _split_columns(body: str) -> list[str]:
    """Split a CREATE TABLE body on TOP-LEVEL commas only.

    Commas inside parentheses (e.g. numeric(10,2)), square brackets
    (ARRAY['a','b']) or single-quoted strings are ignored.
    """
    parts: list[str] = []
    buf: list[str] = []
    depth = 0
    in_quote = False
    for ch in body:
        if ch == "'":
            in_quote = not in_quote
        elif not in_quote:
            if ch in "([":
                depth += 1
            elif ch in ")]":
                depth -= 1
            elif ch == "," and depth == 0:
                parts.append("".join(buf))
                buf = []
                continue
        buf.append(ch)
    if "".join(buf).strip():
        parts.append("".join(buf))
    return parts


_DOLLAR_TAG_RE = re.compile(r"\$[A-Za-z0-9_]*\$")


def _split_sql_statements(sql: str) -> list[str]:
    """Split SQL into statements on top-level `;`.

    Respects single-quoted strings, `--` line comments, and Postgres
    dollar-quoted bodies ($$…$$ / $tag$…$tag$) so function definitions (which
    contain their own semicolons) stay intact.
    """
    stmts: list[str] = []
    buf: list[str] = []
    i, n = 0, len(sql)
    in_squote = False
    dollar_tag: str | None = None
    line_comment = False
    while i < n:
        ch = sql[i]
        if line_comment:
            buf.append(ch)
            if ch == "\n":
                line_comment = False
            i += 1
        elif dollar_tag is not None:
            if sql.startswith(dollar_tag, i):
                buf.append(dollar_tag)
                i += len(dollar_tag)
                dollar_tag = None
            else:
                buf.append(ch)
                i += 1
        elif in_squote:
            buf.append(ch)
            if ch == "'":
                if i + 1 < n and sql[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                in_squote = False
            i += 1
        elif sql.startswith("--", i):
            buf.append("--")
            i += 2
            line_comment = True
        elif ch == "'":
            in_squote = True
            buf.append(ch)
            i += 1
        elif ch == "$" and _DOLLAR_TAG_RE.match(sql, i):
            tag = _DOLLAR_TAG_RE.match(sql, i).group(0)
            dollar_tag = tag
            buf.append(tag)
            i += len(tag)
        elif ch == ";":
            stmt = "".join(buf).strip()
            if stmt:
                stmts.append(stmt)
            buf = []
            i += 1
        else:
            buf.append(ch)
            i += 1
    tail = "".join(buf).strip()
    if tail:
        stmts.append(tail)
    return stmts


def _apply_full_schema_tolerant(conn, schema_sql: str) -> None:
    """Run the whole schema statement-by-statement, ignoring 'already exists'
    errors. Used to complete brand-new tables — their PRIMARY KEY, UNIQUE, FK,
    index and trigger definitions live in SEPARATE statements from the CREATE
    TABLE block. schema.sql is DDL-only (no data), so re-applying is safe."""
    applied = skipped = 0
    for stmt in _split_sql_statements(schema_sql):
        try:
            conn.execute(stmt)
            applied += 1
        except Exception as e:  # noqa: BLE001 — most are harmless 'already exists'
            skipped += 1
            logger.debug("auto-migrate: schema stmt skipped: %s", str(e).splitlines()[0][:140])
    logger.info("auto-migrate: full-schema apply — %s applied, %s already present", applied, skipped)


def _sync_columns_from_schema(conn, schema_sql: str) -> None:
    """Ensure every table/column defined in schema.sql exists in the live DB.

    Idempotent: existing tables/columns are left untouched; only missing ones are
    added. New COLUMNS are added exactly as declared (a NOT NULL column with no
    default on a populated table will fail and be logged — give it a DEFAULT).
    If a whole TABLE is missing, the full schema is re-applied tolerantly so the
    new table gets its constraints/indexes/triggers too — not just its columns.
    It never drops, renames, or changes the type of an existing column.
    """
    def _snapshot() -> dict[str, set]:
        cols: dict[str, set] = {}
        for table_name, column_name in conn.execute(
            "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'"
        ).fetchall():
            cols.setdefault(table_name, set()).add(column_name)
        return cols

    try:
        existing = _snapshot()
    except Exception as e:  # noqa: BLE001
        logger.warning("auto-migrate: could not read existing columns: %s", e)
        return

    # A whole table missing → re-apply the full schema (tables + constraints +
    # indexes + triggers), tolerantly, then re-snapshot.
    schema_tables = {m.group(1) for m in _TABLE_RE.finditer(schema_sql)}
    missing = sorted(schema_tables - set(existing.keys()))
    if missing:
        logger.info("auto-migrate: %d missing table(s): %s — applying full schema", len(missing), ", ".join(missing))
        _apply_full_schema_tolerant(conn, schema_sql)
        try:
            existing = _snapshot()
        except Exception:  # noqa: BLE001
            pass

    # Add any column present in schema.sql but missing from the live table.
    for m in _TABLE_RE.finditer(schema_sql):
        table = m.group(1)
        have = existing.get(table)
        if have is None:
            continue  # table still absent (full apply failed) — nothing to alter
        for raw in _split_columns(m.group(2)):
            col_def = raw.strip().rstrip(",").strip()
            if not col_def or _CONSTRAINT_START.match(col_def):
                continue
            name = col_def.split(None, 1)[0].strip('"').lower()
            if name in have:
                continue
            try:
                conn.execute(f"ALTER TABLE public.{table} ADD COLUMN IF NOT EXISTS {col_def}")
                logger.info("auto-migrate: added column public.%s.%s", table, name)
            except Exception as e:  # noqa: BLE001
                logger.warning("auto-migrate: add column public.%s.%s skipped: %s", table, name, e)


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
