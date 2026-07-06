"""
Supabase-compatible PostgreSQL shim.

Provides a drop-in `supabase`-shaped object backed by a plain PostgreSQL
database (via psycopg 3), so the existing routers can keep calling:

    supabase.table("x").select("*").eq("user_id", uid).execute()
    supabase.table("x").insert({...}).execute()
    supabase.auth.admin.list_users()
    supabase.storage.from_("knowledge").upload(path, content, opts)

Only the subset of the PostgREST query-builder actually used by this codebase
is implemented (select/insert/update/delete + eq/neq/gt/gte/lt/lte/is_/in_/
like/ilike/order/limit/range/single/maybe_single/execute + count="exact").
"""
from __future__ import annotations

import uuid as _uuid
from datetime import date, datetime, time
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json
from psycopg_pool import ConnectionPool

from config import settings


def _json_value(v: Any) -> Any:
    """Coerce psycopg native types to JSON-friendly ones (matches PostgREST/supabase-py output)."""
    if isinstance(v, _uuid.UUID):
        return str(v)
    if isinstance(v, (datetime, date, time)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _json_row(row: dict) -> dict:
    return {k: _json_value(v) for k, v in row.items()}

# ---------------------------------------------------------------------------
# Connection pool (lazy — only opens when first used)
# ---------------------------------------------------------------------------
_pool: ConnectionPool | None = None


def _get_pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        if not settings.database_url:
            raise RuntimeError("DATABASE_URL is not set — cannot connect to PostgreSQL")
        _pool = ConnectionPool(
            settings.database_url,
            min_size=1,
            max_size=10,
            kwargs={"row_factory": dict_row, "autocommit": True},
            open=True,
        )
    return _pool


import atexit


@atexit.register
def _close_pool() -> None:
    global _pool
    if _pool is not None:
        try:
            _pool.close()
        except Exception:
            pass
        _pool = None


def _adapt(value: Any) -> Any:
    """Wrap dict/list so psycopg stores them as JSONB (mirrors supabase-py auto-JSON)."""
    if isinstance(value, (dict, list)):
        return Json(value)
    return value


class APIResponse:
    """Mimics supabase-py's response object: `.data` and `.count`."""

    def __init__(self, data: Any, count: int | None = None):
        self.data = data
        self.count = count


# Sentinel for filters that carry no bound parameter (e.g. IS NULL)
_NOPARAM = object()


class _Query:
    def __init__(self, table: str):
        self._table = table
        self._op = "select"
        self._columns = "*"
        self._count_mode: str | None = None
        self._values: Any = None
        self._filters: list[tuple[str, Any]] = []
        self._order: list[str] = []
        self._limit: int | None = None
        self._offset: int | None = None
        self._single = False
        self._maybe_single = False

    # ---- operation selectors -------------------------------------------------
    def select(self, columns: str = "*", count: str | None = None) -> "_Query":
        self._op = "select"
        self._columns = columns or "*"
        self._count_mode = count
        return self

    def insert(self, values: Any) -> "_Query":
        self._op = "insert"
        self._values = values
        return self

    def update(self, values: dict) -> "_Query":
        self._op = "update"
        self._values = values
        return self

    def delete(self) -> "_Query":
        self._op = "delete"
        return self

    def upsert(self, values: Any, on_conflict: str | None = None) -> "_Query":
        self._op = "upsert"
        self._values = values
        self._on_conflict = on_conflict
        return self

    # ---- filters -------------------------------------------------------------
    def _add(self, frag: str, val: Any = _NOPARAM) -> "_Query":
        self._filters.append((frag, val))
        return self

    def eq(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" = %s', val)

    def neq(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" <> %s', val)

    def gt(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" > %s', val)

    def gte(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" >= %s', val)

    def lt(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" < %s', val)

    def lte(self, col: str, val: Any) -> "_Query":
        return self._add(f'"{col}" <= %s', val)

    def like(self, col: str, pattern: str) -> "_Query":
        return self._add(f'"{col}" LIKE %s', pattern)

    def ilike(self, col: str, pattern: str) -> "_Query":
        return self._add(f'"{col}" ILIKE %s', pattern)

    def is_(self, col: str, val: Any) -> "_Query":
        if val is None or str(val).lower() == "null":
            return self._add(f'"{col}" IS NULL')
        if isinstance(val, bool) or str(val).lower() in ("true", "false"):
            b = val if isinstance(val, bool) else str(val).lower() == "true"
            return self._add(f'"{col}" IS {"TRUE" if b else "FALSE"}')
        return self._add(f'"{col}" IS %s', val)

    def in_(self, col: str, values: list) -> "_Query":
        return self._add(f'"{col}" = ANY(%s)', list(values))

    # ---- modifiers -----------------------------------------------------------
    def order(self, col: str, desc: bool = False) -> "_Query":
        self._order.append(f'"{col}" {"DESC" if desc else "ASC"}')
        return self

    def limit(self, n: int) -> "_Query":
        self._limit = n
        return self

    def range(self, start: int, end: int) -> "_Query":
        # PostgREST range is inclusive on both ends.
        self._offset = start
        self._limit = end - start + 1
        return self

    def single(self) -> "_Query":
        self._single = True
        return self

    def maybe_single(self) -> "_Query":
        self._maybe_single = True
        return self

    # ---- SQL assembly --------------------------------------------------------
    def _where(self) -> tuple[str, list]:
        if not self._filters:
            return "", []
        clauses, params = [], []
        for frag, val in self._filters:
            clauses.append(frag)
            if val is not _NOPARAM:
                params.append(val)
        return " WHERE " + " AND ".join(clauses), params

    def _tail(self) -> str:
        sql = ""
        if self._order:
            sql += " ORDER BY " + ", ".join(self._order)
        if self._limit is not None:
            sql += f" LIMIT {int(self._limit)}"
        if self._offset:
            sql += f" OFFSET {int(self._offset)}"
        return sql

    def _rows_to_values(self) -> tuple[list[str], list[list]]:
        rows = self._values if isinstance(self._values, list) else [self._values]
        rows = [r for r in rows if r is not None]
        if not rows:
            return [], []
        cols = list(rows[0].keys())
        tuples = [[_adapt(r.get(c)) for c in cols] for r in rows]
        return cols, tuples

    # ---- execution -----------------------------------------------------------
    def execute(self) -> APIResponse:
        t = f'"{self._table}"'

        if self._op == "select":
            where, params = self._where()
            count = None
            if self._count_mode == "exact":
                with _get_pool().connection() as conn, conn.cursor() as cur:
                    cur.execute(f"SELECT count(*) AS c FROM {t}{where}", params)
                    count = cur.fetchone()["c"]
            sql = f"SELECT {self._columns} FROM {t}{where}{self._tail()}"
            with _get_pool().connection() as conn, conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
            return self._shape(rows, count)

        if self._op in ("insert", "upsert"):
            cols, tuples = self._rows_to_values()
            if not cols:
                return self._shape([], None)
            collist = ", ".join(f'"{c}"' for c in cols)
            ph_row = "(" + ", ".join(["%s"] * len(cols)) + ")"
            placeholders = ", ".join([ph_row] * len(tuples))
            flat = [v for tup in tuples for v in tup]
            conflict = ""
            if self._op == "upsert":
                target = getattr(self, "_on_conflict", None)
                if target:
                    updates = ", ".join(f'"{c}" = EXCLUDED."{c}"' for c in cols)
                    conflict = f' ON CONFLICT ({target}) DO UPDATE SET {updates}'
            sql = f"INSERT INTO {t} ({collist}) VALUES {placeholders}{conflict} RETURNING *"
            with _get_pool().connection() as conn, conn.cursor() as cur:
                cur.execute(sql, flat)
                rows = cur.fetchall()
            return self._shape(rows, None)

        if self._op == "update":
            where, wparams = self._where()
            set_cols = list(self._values.keys())
            set_clause = ", ".join(f'"{c}" = %s' for c in set_cols)
            set_params = [_adapt(self._values[c]) for c in set_cols]
            sql = f"UPDATE {t} SET {set_clause}{where} RETURNING *"
            with _get_pool().connection() as conn, conn.cursor() as cur:
                cur.execute(sql, set_params + wparams)
                rows = cur.fetchall()
            return self._shape(rows, None)

        if self._op == "delete":
            where, params = self._where()
            sql = f"DELETE FROM {t}{where} RETURNING *"
            with _get_pool().connection() as conn, conn.cursor() as cur:
                cur.execute(sql, params)
                rows = cur.fetchall()
            return self._shape(rows, None)

        raise ValueError(f"Unsupported operation: {self._op}")

    def _shape(self, rows: list[dict], count: int | None) -> APIResponse:
        rows = [_json_row(r) for r in rows]
        if self._single:
            if len(rows) != 1:
                raise psycopg.errors.DataError(
                    f"single() expected exactly 1 row, got {len(rows)}"
                )
            return APIResponse(rows[0], count)
        if self._maybe_single:
            return APIResponse(rows[0] if rows else None, count)
        return APIResponse(rows, count)


# ---------------------------------------------------------------------------
# auth.admin shim — reads the local `users` table (replaces auth.users)
# ---------------------------------------------------------------------------
class _AuthAdmin:
    def list_users(self) -> list[SimpleNamespace]:
        with _get_pool().connection() as conn, conn.cursor() as cur:
            cur.execute("SELECT id, email, raw_user_meta_data, created_at FROM users")
            return [
                SimpleNamespace(
                    id=r["id"],
                    email=r["email"],
                    user_metadata=r.get("raw_user_meta_data") or {},
                    created_at=r.get("created_at"),
                )
                for r in cur.fetchall()
            ]

    def get_user_by_id(self, user_id: str) -> SimpleNamespace:
        with _get_pool().connection() as conn, conn.cursor() as cur:
            cur.execute(
                "SELECT id, email, raw_user_meta_data, created_at FROM users WHERE id = %s",
                [user_id],
            )
            r = cur.fetchone()
        user = (
            SimpleNamespace(
                id=r["id"],
                email=r["email"],
                user_metadata=r.get("raw_user_meta_data") or {},
                created_at=r.get("created_at"),
            )
            if r
            else None
        )
        return SimpleNamespace(user=user)


class _Auth:
    def __init__(self):
        self.admin = _AuthAdmin()


# ---------------------------------------------------------------------------
# storage shim — writes to a local directory (replaces Supabase Storage)
# ---------------------------------------------------------------------------
class _StorageBucket:
    def __init__(self, bucket: str):
        base = settings.storage_dir or str(Path(__file__).resolve().parent / "_storage")
        self._dir = Path(base) / bucket
        self._dir.mkdir(parents=True, exist_ok=True)

    def upload(self, path: str, content: bytes, options: dict | None = None):
        dest = self._dir / path
        dest.parent.mkdir(parents=True, exist_ok=True)
        with open(dest, "wb") as f:
            f.write(content)
        return SimpleNamespace(path=str(dest), full_path=str(dest))

    def download(self, path: str) -> bytes:
        with open(self._dir / path, "rb") as f:
            return f.read()

    def remove(self, paths: list[str]):
        for p in paths:
            try:
                (self._dir / p).unlink()
            except FileNotFoundError:
                pass


class _Storage:
    def from_(self, bucket: str) -> _StorageBucket:
        return _StorageBucket(bucket)


# ---------------------------------------------------------------------------
# Top-level supabase-shaped client
# ---------------------------------------------------------------------------
class PostgresClient:
    def __init__(self):
        self.auth = _Auth()
        self.storage = _Storage()

    def table(self, name: str) -> _Query:
        return _Query(name)

    # supabase-py also exposes `.from_` as an alias of `.table`
    def from_(self, name: str) -> _Query:
        return _Query(name)


supabase = PostgresClient()
