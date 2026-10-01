"""
Shared harness for the call-events test suite.

SAFETY: importing this module points the whole backend at a throw-away database
(`nexus_qa_callevents`, created fresh on the same PostgreSQL server) and swaps in a
fake VAPI key, so the suite can never read/write the real dev database or create real
VAPI resources. Every VAPI network function is replaced by a mock (see `VapiMock`).

Run from the backend folder:  python -m unittest discover -s tests -v
"""
import os
import re
import sys
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
from urllib.parse import urlparse, urlunparse

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
os.chdir(BACKEND)

QA_DB = "nexus_qa_callevents"


def _real_database_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        for env_file in (BACKEND / ".env", BACKEND.parent / ".env"):
            if env_file.exists():
                m = re.search(r"^DATABASE_URL\s*=\s*(.+)$", env_file.read_text(encoding="utf-8"), re.M)
                if m:
                    url = m.group(1).strip().strip('"').strip("'")
                    break
    if not url:
        raise RuntimeError("DATABASE_URL not found in the environment, backend/.env or ./.env")
    return url


_u = urlparse(_real_database_url())
ADMIN_URL = urlunparse(_u._replace(path="/postgres"))
QA_URL = urlunparse(_u._replace(path=f"/{QA_DB}"))

os.environ["DATABASE_URL"] = QA_URL
os.environ["VAPI_API_KEY"] = "qa-fake-vapi-key"
os.environ["PUBLIC_API_URL"] = "https://qa.example.test"
os.environ["VAPI_WEBHOOK_SECRET"] = ""
os.environ["VAPI_SYNC_INTERVAL_SECONDS"] = "0"

from config import settings  # noqa: E402

# Another test module may have imported `config` before this harness (so the env vars
# above came too late) — force the QA settings on the live object either way, and drop
# any connection pool that was opened against the real database.
settings.database_url = QA_URL
settings.vapi_api_key = "qa-fake-vapi-key"
settings.public_api_url = "https://qa.example.test"
settings.vapi_webhook_secret = ""
settings.vapi_sync_interval_seconds = 0

import db_pg  # noqa: E402

if getattr(db_pg, "_pool", None) is not None:
    db_pg._pool.close()
    db_pg._pool = None

assert QA_DB in settings.database_url, "refusing to run: not pointed at the QA database"

import psycopg  # noqa: E402


def recreate_qa_database() -> None:
    with psycopg.connect(ADMIN_URL, autocommit=True) as c:
        c.execute(f"DROP DATABASE IF EXISTS {QA_DB} WITH (FORCE)")
        c.execute(f"CREATE DATABASE {QA_DB}")
    import migrate
    migrate.bootstrap_schema()


_bootstrapped = False


def ensure_db() -> None:
    global _bootstrapped
    if not _bootstrapped:
        recreate_qa_database()
        _bootstrapped = True


ensure_db()

from fastapi.testclient import TestClient  # noqa: E402
from jose import jwt  # noqa: E402
from database import supabase  # noqa: E402
import main  # noqa: E402
from routers import agent_tool_callbacks  # noqa: E402
from services import vapi_client  # noqa: E402

client = TestClient(main.app)


def sql(query: str, params=None):
    """Run raw SQL against the QA database (for assertions the shim can't express)."""
    with psycopg.connect(QA_URL, autocommit=True) as c:
        cur = c.execute(query, params or ())
        return cur.fetchall() if cur.description else None


def make_user(prefix="qa") -> str:
    email = f"{prefix}-{uuid.uuid4().hex[:8]}@qa.test"
    res = supabase.table("users").insert({"email": email}).execute()
    return res.data[0]["id"]


def token_for(user_id: str) -> str:
    return jwt.encode({"sub": user_id, "email": "qa@qa.test", "aud": "authenticated"},
                      settings.active_jwt_secret, algorithm="HS256")


def auth(user_id: str) -> dict:
    return {"Authorization": f"Bearer {token_for(user_id)}"}


def reset_rate_limits() -> None:
    for lim in (agent_tool_callbacks.limiter, getattr(main, "limiter", None)):
        try:
            lim.reset()
        except Exception:
            pass


class VapiMock:
    """Replaces every network function in services.vapi_client used by the feature."""

    def __init__(self):
        self.n = 0
        self.create_tool = AsyncMock(side_effect=self._create_tool)
        self.update_tool = AsyncMock(return_value={})
        self.delete_tool = AsyncMock(return_value=None)
        self.create_assistant = AsyncMock(side_effect=self._create_assistant)
        self.update_assistant = AsyncMock(return_value={})
        self.delete_assistant = AsyncMock(return_value=None)

    async def _create_tool(self, payload):
        self.n += 1
        return {"id": f"tool-{self.n}-{uuid.uuid4().hex[:6]}"}

    async def _create_assistant(self, payload):
        self.n += 1
        return {"id": f"asst-{self.n}-{uuid.uuid4().hex[:6]}"}

    def start(self):
        self._patches = [
            patch.object(vapi_client, name, getattr(self, name))
            for name in ("create_tool", "update_tool", "delete_tool", "create_assistant",
                         "update_assistant", "delete_assistant")
        ]
        for p in self._patches:
            p.start()
        return self

    def stop(self):
        for p in self._patches:
            p.stop()


def create_agent_via_api(user_id: str, events=None, name="QA Agent", **extra) -> dict:
    body = {"name": name, "system_prompt": "You are a QA bot.", "first_message": "Hi",
            "language": "en", **extra}
    if events is not None:
        body["call_events"] = events
    r = client.post("/agents", json=body, headers=auth(user_id))
    assert r.status_code == 200, r.text
    return r.json()["data"]


def make_conversation(user_id: str, vapi_call_id=None, agent_id=None, **extra) -> dict:
    row = {"user_id": user_id, "channel": "Phone", "status": "In Progress",
           "vapi_call_id": vapi_call_id, "agent_id": agent_id, **extra}
    return supabase.table("conversations").insert(row).execute().data[0]


def tool_call_body(assistant_id, call_id, calls):
    """calls: list of (tool_call_id, arguments) -> a VAPI tool-calls request body."""
    return {"message": {
        "type": "tool-calls",
        "call": {"id": call_id, "assistantId": assistant_id},
        "toolCalls": [
            {"id": tcid, "type": "function", "function": {"name": "trigger_event", "arguments": args}}
            for tcid, args in calls
        ],
    }}


def end_of_call_body(assistant_id, call_id, ended_reason="customer-ended-call", seconds=42):
    return {"message": {
        "type": "end-of-call-report",
        "endedReason": ended_reason,
        "call": {"id": call_id, "assistantId": assistant_id, "type": "outboundPhoneCall"},
        "artifact": {"transcript": "AI: Hi\nUser: call me later", "messages": [], "recordingUrl": ""},
        "durationSeconds": seconds,
    }}
