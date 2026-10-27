"""In-product assistant chat (`POST /support/chat`): the bubble signed-in users see on every dashboard page.

The browser sends the recent conversation (the assistant keeps no server-side record) and gets the next reply, written by
services/openai_client.chat_conversation with the prompt from services/support_assistant.py. Any signed-in user may use
it, Viewer-role team members included (TeamRoleGuard exempts this path: asking a question changes nothing). It cannot
read or change the user's account; see the assistant's prompt.

Limits: 12 messages of history, 1000 characters per message, 20 requests/minute per address, and MAX_PER_DAY replies per
user per UTC day (in memory, per process: a brake on a runaway bill, not an exact meter). Errors are `detail` text safe to
show the user: 400 bad input, 429 daily limit, 503 AI unavailable.
"""
import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from slowapi import Limiter
from slowapi.util import get_remote_address

from dependencies import get_current_user
from services.openai_client import OpenAIError, chat_conversation
from services.support_assistant import system_prompt

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/support", tags=["Support"])
limiter = Limiter(key_func=get_remote_address)

MAX_HISTORY = 12
MAX_MESSAGE = 1000
MAX_PER_DAY = 100
# {user id: (UTC day, replies given that day)}
_day_counts: dict[str, tuple[str, int]] = {}


class SupportChatBody(BaseModel):
    """`messages` is the conversation so far, oldest first, ending with the user's new question."""
    messages: list[dict[str, Any]] = []


def _clean_history(raw: list[dict]) -> list[dict]:
    """Validate and trim the history; 400 for anything that is not a plain user/assistant text turn ending with the user."""
    if not raw:
        raise HTTPException(status_code=400, detail="Please type a message.")
    history = []
    for m in raw[-MAX_HISTORY:]:
        role, content = m.get("role"), m.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            raise HTTPException(status_code=400, detail="Invalid request.")
        content = content.strip()
        if not content:
            continue
        if len(content) > MAX_MESSAGE:
            raise HTTPException(status_code=400, detail=f"Please keep your message under {MAX_MESSAGE} characters.")
        history.append({"role": role, "content": content})
    if not history or history[-1]["role"] != "user":
        raise HTTPException(status_code=400, detail="Please type a message.")
    return history


def _within_daily_limit(user_id: str) -> bool:
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    day, n = _day_counts.get(user_id, (today, 0))
    if day != today:
        n = 0
    if n >= MAX_PER_DAY:
        return False
    _day_counts[user_id] = (today, n + 1)
    return True


@router.post("/chat")
@limiter.limit("20/minute")
async def support_chat(request: Request, body: SupportChatBody, user=Depends(get_current_user)):
    """Answer the user's latest question as the NEXUS assistant. Returns `{"data": {"reply": text}}`."""
    history = _clean_history(body.messages)
    if not _within_daily_limit(user["user_id"]):
        raise HTTPException(status_code=429, detail="You have reached today's chat limit. Please try again tomorrow, or email our support team.")
    try:
        reply = await chat_conversation(system_prompt(), history)
    except OpenAIError as e:
        logger.error("Support assistant could not get a reply: %s", e)
        raise HTTPException(status_code=503, detail="The assistant is unavailable right now. Please try again in a moment.")
    return {"data": {"reply": reply}, "error": None}
