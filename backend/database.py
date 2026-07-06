"""
Database access.

Migrated from Supabase (PostgREST) to plain PostgreSQL. `supabase` is now a
compatibility shim (see db_pg.py) that speaks the same query-builder API the
routers already use, but runs against a standard PostgreSQL database via
DATABASE_URL. No router changes required.
"""
from db_pg import supabase  # noqa: F401  (re-exported for existing imports)
