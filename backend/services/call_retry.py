"""
Call retry / redial for outbound campaigns: a number that did not pick up is called again after a set
delay, up to a maximum number of calls, all configurable per campaign.

Campaign settings (columns of `outbound_campaigns`, off by default)
  retry_enabled           on/off
  retry_max_attempts      calls per number in all, the first one included (1-10)
  retry_interval_minutes  wait after a call ENDS before the next one (5-60)
  retry_on                which outcomes trigger a redial: no_answer, busy, voicemail, failed

Data (two tables, written for EVERY campaign call, retry on or not)
  campaign_leads     one row per number (contact) of a campaign: calls so far in the current round, last
                     outcome, when the next call is due and, once it is settled, `final_status`
                     (NULL = still going). A "round" is one pass of the campaign over its list: pressing
                     Start again dials the whole list again and begins a new round for every number.
  campaign_attempts  one row per call placed: attempt number, when it was placed and ended, its outcome
                     and the settings it was placed under (a snapshot, see below).

How it flows
  1. Every call a campaign places (the main run and the retries alike) first takes an attempt row. A
     partial unique index on (user_id, phone_key) WHERE ended_at IS NULL means a number can hold only ONE
     open attempt, so it is never called twice at the same time, even by two campaigns or two sweeps.
  2. When the call ends (end-of-call webhook, or the periodic VAPI sync) `on_call_ended` classifies it
     (`classify`) and `finish_attempt` settles the number: a person talked / transferred / disqualified /
     asked not to be called / invalid number -> never redialed; no answer / busy / voicemail / failed ->
     redial at (call end + interval) when the outcome is ticked in `retry_on` and attempts are left,
     otherwise "Max Attempts Reached" (or "Not retried" when that outcome is not ticked).
  3. The campaign sweep (services/campaign_scheduler.py) places every due redial of a campaign that is
     Active and inside its calling hours. A paused/stopped campaign keeps its pending redials, which carry
     on when it is Active again. The due time is moved to the next opening when it falls outside the hours.

"Changing the settings applies to future attempts only": the outcome of a call that is in progress is
decided with the settings it was PLACED under (snapshot in `campaign_attempts.settings`). Redials not yet
placed use the current maximum and on/off switch; their scheduled time is not recomputed.
"""
import logging
import re
from datetime import datetime, timedelta, timezone

import psycopg

from database import supabase
from db_pg import _get_pool
from services import call_hours

logger = logging.getLogger(__name__)

# ── settings ──
RETRYABLE = ("no_answer", "busy", "voicemail", "failed")
RETRY_LABELS = {
    "no_answer": "No answer",
    "busy": "Busy",
    "voicemail": "Voicemail / answering machine",
    "failed": "Call failed / network error",
}
FIELDS = ("retry_enabled", "retry_max_attempts", "retry_interval_minutes", "retry_on")
DEFAULTS = {
    "retry_enabled": False,
    "retry_max_attempts": 3,
    "retry_interval_minutes": 10,
    "retry_on": list(RETRYABLE),
}
MAX_ATTEMPTS_RANGE = (1, 10)
INTERVAL_RANGE = (5, 60)

# ── outcomes of one call ──
# A person talked to the agent (any length), the call was transferred, or the conversation ended in a
# disqualification / opt-out: none of these is ever called again.
CONNECTED = ("answered", "transferred", "disqualified", "do_not_call")
NEVER_RETRY = CONNECTED + ("invalid_number",)
OUTCOMES = RETRYABLE + NEVER_RETRY

# ── final status of a number (NULL final_status = still going) ──
MAX_ATTEMPTS = "max_attempts"       # "Max Attempts Reached"
NOT_RETRIED = "not_retried"         # the outcome was not one to retry (or retrying is off / was switched off)
FINAL_STATUSES = NEVER_RETRY + (MAX_ATTEMPTS, NOT_RETRIED)
FINAL_LABELS = {
    "answered": "Answered",
    "transferred": "Transferred",
    "disqualified": "Disqualified",
    "do_not_call": "Do not call",
    "invalid_number": "Invalid number",
    "max_attempts": "Max attempts reached",
    "not_retried": "Not retried",
}

# A call that ended with an error after this many seconds of talking was a real conversation that broke
# off, not a failed call: it counts as answered and is not redialed.
FAILED_AFTER_TALK_SECONDS = 30
# A call whose end report never arrived is closed after this long (it frees the number for the next call).
STALE_ATTEMPT_MINUTES = 90

FINISHED_STATUSES = ("Completed", "Failed", "No Answer")


class RetryError(ValueError):
    """A retry setting is invalid; the message is shown to the user."""


# ── clock ──

def _now() -> datetime:
    return datetime.now(timezone.utc)


def iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def parse_time(value) -> datetime | None:
    """A timestamp as a UTC datetime, from a datetime or an ISO string (VAPI's or the database's); None when
    it is missing or unreadable."""
    if not value:
        return None
    try:
        t = value if isinstance(value, datetime) else datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).astimezone(timezone.utc)


# ── validation ──

def touched(updates: dict) -> bool:
    """True when `updates` (a request body as a dict) sets any retry field."""
    return any(k in updates for k in FIELDS)


def _int(value, name: str, low: int, high: int, unit: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise RetryError(f"{name} must be a whole number of {unit} from {low} to {high}.")
    return value


def validate(existing: dict | None, updates: dict) -> dict:
    """The retry settings as they will be stored: `updates` merged over `existing` (then over the defaults),
    checked and normalised. Raises RetryError with a message for the user."""
    merged = {}
    for key in FIELDS:
        v = updates.get(key)
        if v is None:
            v = (existing or {}).get(key)
        merged[key] = DEFAULTS[key] if v is None else v
    if not isinstance(merged["retry_enabled"], bool):
        raise RetryError("Enable auto redial must be true or false.")
    _int(merged["retry_max_attempts"], "Calls per number", *MAX_ATTEMPTS_RANGE, "calls")
    _int(merged["retry_interval_minutes"], "Wait between calls", *INTERVAL_RANGE, "minutes")
    chosen = merged["retry_on"]
    if not isinstance(chosen, (list, tuple)) or any(not isinstance(c, str) for c in chosen):
        raise RetryError("Retry on must be a list of outcomes.")
    unknown = [c for c in chosen if c not in RETRYABLE]
    if unknown:
        raise RetryError(f"Unknown retry outcome: {unknown[0]}. Choose from {', '.join(RETRYABLE)}.")
    merged["retry_on"] = [o for o in RETRYABLE if o in chosen]      # de-duplicated, in a fixed order
    if merged["retry_enabled"] and not merged["retry_on"]:
        raise RetryError("Choose at least one outcome to redial on (no answer, busy, voicemail or call failed).")
    return {k: merged[k] for k in FIELDS}


def settings_of(camp: dict | None) -> dict:
    """The retry settings of a campaign row as the short dict stored on each attempt."""
    row = camp or {}
    s = {k: row.get(k) if row.get(k) is not None else DEFAULTS[k] for k in FIELDS}
    return {
        "enabled": bool(s["retry_enabled"]),
        "max_attempts": int(s["retry_max_attempts"]),
        "interval_minutes": int(s["retry_interval_minutes"]),
        "retry_on": list(s["retry_on"]),
    }


# ── classifying one finished call ──

_DNC_WORDS = re.compile(r"\b(do not call|dnc|opt(?:ed)? out|unsubscribe|stop calling|remove me|remove from)\b")
_DISQ_WORDS = re.compile(r"\b(disqualified|not qualified|unqualified)\b")
_INVALID_OUTCOME = re.compile(r"\b(wrong number|invalid number|disconnected|not in service)\b")
_INVALID_REASON = ("invalid", "unallocated", "not-in-service", "unassigned", "number-disconnected",
                   "disconnected-number", "not-a-valid", "no-such-number")


def _words(text) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(text or "").lower()).strip()


def classify(ended_reason, status=None, duration_seconds=None, qualified=False, call_outcome=None) -> str:
    """What one finished call was, as one of OUTCOMES. First match wins:
      transferred (handed to a human) > opt-out / disqualified / wrong number (what the agent recorded) >
      invalid or disconnected number > voicemail > busy > no answer > failed (an error, or the provider
      could not connect; an error AFTER a real conversation does not count) > answered."""
    r = (ended_reason or "").lower()
    try:
        seconds = float(duration_seconds or 0)
    except (TypeError, ValueError):
        seconds = 0
    if qualified or "forwarded" in r or "transfer" in r:
        return "transferred"
    said = _words(call_outcome)
    if said:
        if _DNC_WORDS.search(said):
            return "do_not_call"
        if _DISQ_WORDS.search(said):
            return "disqualified"
        if _INVALID_OUTCOME.search(said):
            return "invalid_number"
    if any(t in r for t in _INVALID_REASON):
        return "invalid_number"
    if "voicemail" in r:
        return "voicemail"
    if "busy" in r:
        return "busy"
    if "did-not-answer" in r or "no-answer" in r:
        return "no_answer"
    if "error" in r or "failed" in r or "rejected" in r:
        return "answered" if seconds >= FAILED_AFTER_TALK_SECONDS else "failed"
    if status == "No Answer":
        return "no_answer"
    if status == "Failed":
        return "failed"
    return "answered"


# ── numbers ──

def phone_key(phone) -> str:
    """Last 10 digits of a phone number: the same number written differently (+1..., spaces, dashes) gets
    the same key. A "number" with no digits is keyed by its text."""
    digits = "".join(ch for ch in str(phone or "") if ch.isdigit())
    return digits[-10:] if digits else str(phone or "").strip()


# ── leads and attempts ──

def _table(name: str):
    return supabase.table(name)


def _get_lead(campaign_id: str, contact_id: str) -> dict | None:
    rows = _table("campaign_leads").select("*").eq("campaign_id", campaign_id).eq("contact_id", contact_id).limit(1).execute().data
    return rows[0] if rows else None


def _get_or_create_lead(camp: dict, contact: dict) -> dict:
    lead = _get_lead(camp["id"], contact["id"])
    if lead:
        return lead
    try:
        return _table("campaign_leads").insert({
            "campaign_id": camp["id"], "user_id": camp["user_id"], "contact_id": contact["id"], "phone": contact["phone"],
        }).execute().data[0]
    except psycopg.errors.UniqueViolation:       # another run created it a moment ago
        return _get_lead(camp["id"], contact["id"])


def begin_attempt(camp: dict, contact: dict, *, new_round: bool, lead: dict | None = None) -> dict | None:
    """Take the next attempt for `contact`: returns the open attempt row, or None when the number is on
    another call right now (or the number's state changed under us), in which case NO call may be placed.

    `new_round` is for the campaign's own run: the number starts again at attempt 1 (its earlier rounds
    stay in the history). A redial passes the due `lead` and continues at attempts + 1."""
    lead = lead or _get_or_create_lead(camp, contact)
    key = phone_key(contact["phone"])
    reap_stale(camp["user_id"], key)
    if new_round:
        round_no = lead["round"] + 1 if lead["attempts"] > 0 else lead["round"]
        number = 1
    else:
        round_no, number = lead["round"], lead["attempts"] + 1
    try:
        attempt = _table("campaign_attempts").insert({
            "lead_id": lead["id"], "campaign_id": camp["id"], "user_id": camp["user_id"], "phone_key": key,
            "round": round_no, "attempt_number": number, "placed_at": iso(_now()), "settings": settings_of(camp),
        }).execute().data[0]
    except psycopg.errors.UniqueViolation:       # the unique index: this number already has a call open
        return None
    fields = {"round": round_no, "attempts": number, "last_attempt_at": attempt["placed_at"], "updated_at": iso(_now()),
              "phone": contact["phone"], "next_attempt_at": None}
    if new_round:
        fields.update({"final_status": None, "last_outcome": None})
    # Only if the number is exactly as it was read (nobody else took this attempt): otherwise give it back.
    q = _table("campaign_leads").update(fields).eq("id", lead["id"]).eq("round", lead["round"]).eq("attempts", lead["attempts"])
    if not new_round:
        # A redial only continues a number that is still going: one settled or cancelled since it was read is left alone.
        q = q.is_("final_status", "null")
    won = q.execute().data
    if not won:
        _table("campaign_attempts").delete().eq("id", attempt["id"]).execute()
        return None
    return attempt


def mark_placed(attempt: dict, vapi_call_id: str | None) -> None:
    """Remember which VAPI call the attempt is, so its end can be matched to it."""
    if vapi_call_id:
        _table("campaign_attempts").update({"vapi_call_id": str(vapi_call_id)}).eq("id", attempt["id"]).execute()


# A provider's rejection that names the NUMBER as the problem ("invalid phone number", "number is not valid"):
# redialing cannot help. Anything else (a bad key, an outage, a limit) says nothing about the number.
_NUMBER_REJECTED = re.compile(
    r"\b(invalid|not a valid|not valid|unallocated|disconnected|unassigned)\W+(?:\w+\W+){0,3}(phone|number|e\.?164)\b"
    r"|\b(phone|number|e\.?164)\W+(?:\w+\W+){0,3}(is |was |are )?(invalid|not a valid|not valid|unallocated|disconnected)\b",
    re.I,
)


def placement_outcome(error) -> str:
    """"invalid_number" when the provider refused the call because the number itself is bad, else "failed"."""
    return "invalid_number" if _NUMBER_REJECTED.search(str(error or "")) else "failed"


def placement_failed(attempt: dict, error) -> None:
    """The call could not be placed at all (provider error, network): that attempt is a failed call, or an invalid
    number when the provider says the number itself was rejected."""
    finish_attempt(attempt, placement_outcome(error), f"could not be placed: {error}"[:500])


def settle(lead: dict, final_status: str) -> bool:
    """Stop calling this number for the reason `final_status` (no call is placed). Only if the number is
    still as it was read."""
    won = (_table("campaign_leads").update({"final_status": final_status, "next_attempt_at": None, "updated_at": iso(_now())})
           .eq("id", lead["id"]).eq("round", lead["round"]).eq("attempts", lead["attempts"]).is_("final_status", "null").execute().data)
    return bool(won)


def cancel_pending(campaign_id: str) -> None:
    """Retrying was switched off: the redials still waiting will not be placed ("Not retried")."""
    (_table("campaign_leads").update({"final_status": NOT_RETRIED, "next_attempt_at": None, "updated_at": iso(_now())})
     .eq("campaign_id", campaign_id).is_("final_status", "null").not_.is_("next_attempt_at", "null").execute())


def schedule(camp: dict, moment: datetime) -> datetime:
    """`moment`, or the next moment the campaign's calling hours are open when `moment` is outside them."""
    if not call_hours.enabled(camp, call_hours.CAMPAIGN):
        return moment
    nxt = call_hours.next_opening(camp, call_hours.CAMPAIGN, moment)
    return nxt or moment        # unreadable hours: keep the time, the placement re-checks (and fails closed)


def finish_attempt(attempt: dict, outcome: str, ended_reason: str | None = None, ended_at: datetime | None = None) -> bool:
    """Close an open attempt with its outcome and settle its number (see the module docstring). Returns
    False when the attempt was already closed (a webhook delivered twice, or the sync got there first)."""
    ended = ended_at or _now()
    won = (_table("campaign_attempts")
           .update({"ended_at": iso(ended), "outcome": outcome, "ended_reason": ended_reason})
           .eq("id", attempt["id"]).is_("ended_at", "null").execute().data)
    if not won:
        return False
    lead = _table("campaign_leads").select("*").eq("id", attempt["lead_id"]).limit(1).execute().data
    lead = lead[0] if lead else None
    # A number that has moved on (a new round began, or a later attempt exists) is not changed by an old call.
    if not lead or lead["round"] != attempt["round"] or lead["attempts"] != attempt["attempt_number"]:
        return True
    snap = attempt.get("settings") or {}
    final, next_at = None, None
    if outcome in NEVER_RETRY:
        final = outcome
    elif not snap.get("enabled") or outcome not in (snap.get("retry_on") or []):
        final = NOT_RETRIED
    elif attempt["attempt_number"] >= int(snap.get("max_attempts") or 1):
        final = MAX_ATTEMPTS
    else:
        camp = _table("outbound_campaigns").select("*").eq("id", attempt["campaign_id"]).limit(1).execute().data
        due = ended + timedelta(minutes=int(snap.get("interval_minutes") or DEFAULTS["retry_interval_minutes"]))
        next_at = iso(schedule(camp[0], due)) if camp else iso(due)
    (_table("campaign_leads")
     .update({"last_attempt_at": iso(ended), "last_outcome": outcome, "final_status": final, "next_attempt_at": next_at,
              "updated_at": iso(_now())})
     .eq("id", lead["id"]).eq("round", lead["round"]).eq("attempts", lead["attempts"]).execute())
    return True


def on_call_ended(vapi_call_id: str | None, ended_at=None) -> None:
    """Hook for a finished call (end-of-call webhook and the VAPI sync, after the conversation row is
    written): classify the call and settle its number. Does nothing for a call no campaign attempt is
    waiting on, one that has not finished, or one already handled."""
    if not vapi_call_id:
        return
    rows = _table("campaign_attempts").select("*").eq("vapi_call_id", str(vapi_call_id)).is_("ended_at", "null").limit(1).execute().data
    if not rows:
        return
    conv = _table("conversations").select("status, ended_reason, duration_seconds, qualified, call_outcome") \
        .eq("vapi_call_id", str(vapi_call_id)).limit(1).execute().data
    if not conv or conv[0].get("status") not in FINISHED_STATUSES:
        return
    c = conv[0]
    outcome = classify(c.get("ended_reason"), c.get("status"), c.get("duration_seconds"), bool(c.get("qualified")), c.get("call_outcome"))
    finish_attempt(rows[0], outcome, c.get("ended_reason"), parse_time(ended_at))


def reap_stale(user_id: str | None = None, key: str | None = None) -> int:
    """Close attempts whose call never reported an end (older than STALE_ATTEMPT_MINUTES), so they stop
    holding their number: first from the call's own conversation when it did finish, else as a failed call.
    Limited to one account / number when given. Returns how many were closed."""
    q = _table("campaign_attempts").select("*").is_("ended_at", "null").lt("placed_at", iso(_now() - timedelta(minutes=STALE_ATTEMPT_MINUTES)))
    if user_id:
        q = q.eq("user_id", user_id)
    if key:
        q = q.eq("phone_key", key)
    closed = 0
    for attempt in q.execute().data or []:
        try:
            on_call_ended(attempt.get("vapi_call_id"))
            if _table("campaign_attempts").select("ended_at").eq("id", attempt["id"]).execute().data[0]["ended_at"] is None:
                finish_attempt(attempt, "failed", "no end-of-call report received")
            closed += 1
        except Exception:  # noqa: BLE001 - one bad row must not stop the others
            logger.exception("could not close stale attempt %s", attempt.get("id"))
    return closed


# ── reading: stats and the numbers view ──

def stats(user_id: str, campaign_ids: list[str]) -> dict:
    """{campaign_id: {...}} for the campaign cards: total_attempts, retries_placed (attempts after a
    number's first), answered_on_retry (numbers a person talked to on a later attempt), max_attempts_reached,
    pending_retries (numbers waiting for a redial) and numbers (rows tracked). Every figure is for the current
    round of each number (Start again begins a new round, whose figures start from zero; the earlier rounds stay
    in each number's history)."""
    out = {cid: {"total_attempts": 0, "retries_placed": 0, "answered_on_retry": 0, "max_attempts_reached": 0,
                 "pending_retries": 0, "numbers": 0} for cid in campaign_ids}
    if not campaign_ids:
        return out
    with _get_pool().connection() as conn:
        for r in conn.execute(
            "SELECT a.campaign_id::text AS cid, count(*) AS total, count(*) FILTER (WHERE a.attempt_number > 1) AS retries "
            "FROM public.campaign_attempts a JOIN public.campaign_leads l ON l.id = a.lead_id AND l.round = a.round "
            "WHERE a.user_id = %s AND a.campaign_id = ANY(%s::uuid[]) GROUP BY a.campaign_id",
            (user_id, campaign_ids),
        ).fetchall():
            out[r["cid"]]["total_attempts"], out[r["cid"]]["retries_placed"] = r["total"], r["retries"]
        for r in conn.execute(
            "SELECT campaign_id::text AS cid, count(*) AS numbers, "
            "count(*) FILTER (WHERE final_status = ANY(%s) AND attempts > 1) AS answered_on_retry, "
            "count(*) FILTER (WHERE final_status = %s) AS max_reached, "
            "count(*) FILTER (WHERE final_status IS NULL AND next_attempt_at IS NOT NULL) AS pending "
            "FROM public.campaign_leads WHERE user_id = %s AND campaign_id = ANY(%s::uuid[]) GROUP BY campaign_id",
            (list(CONNECTED), MAX_ATTEMPTS, user_id, campaign_ids),
        ).fetchall():
            o = out[r["cid"]]
            o["numbers"], o["answered_on_retry"] = r["numbers"], r["answered_on_retry"]
            o["max_attempts_reached"], o["pending_retries"] = r["max_reached"], r["pending"]
    return out


def numbers(camp: dict, status: str = "all", limit: int = 100, offset: int = 0) -> dict:
    """The lead/number view of one campaign: every number with its attempt count, last outcome, next retry
    time, status and the history of its calls. `status`: all | pending (still going) | finished | one
    final status. Returns {"rows", "total"}."""
    where, params = ["l.campaign_id = %s", "l.user_id = %s"], [camp["id"], camp["user_id"]]
    if status == "pending":
        where.append("l.final_status IS NULL")
    elif status == "finished":
        where.append("l.final_status IS NOT NULL")
    elif status in FINAL_STATUSES:
        where.append("l.final_status = %s")
        params.append(status)
    elif status != "all":
        raise RetryError(f"Unknown status filter: {status}.")
    clause = " AND ".join(where)
    limit = max(1, min(int(limit), 500))
    with _get_pool().connection() as conn:
        total = conn.execute(f"SELECT count(*) AS c FROM public.campaign_leads l WHERE {clause}", params).fetchone()["c"]
        rows = conn.execute(
            f"SELECT l.id::text, l.contact_id::text, l.phone, l.round, l.attempts, l.last_attempt_at, l.last_outcome, "
            f"l.next_attempt_at, l.final_status, c.name, "
            f"EXISTS (SELECT 1 FROM public.campaign_attempts a WHERE a.lead_id = l.id AND a.ended_at IS NULL) AS calling "
            f"FROM public.campaign_leads l LEFT JOIN public.contacts c ON c.id = l.contact_id WHERE {clause} "
            f"ORDER BY l.next_attempt_at NULLS LAST, l.last_attempt_at DESC NULLS LAST, l.id LIMIT %s OFFSET %s",
            params + [limit, max(0, int(offset))],
        ).fetchall()
        ids = [r["id"] for r in rows]
        history = {}
        if ids:
            for a in conn.execute(
                "SELECT lead_id::text AS lead_id, round, attempt_number, placed_at, ended_at, outcome, ended_reason "
                "FROM public.campaign_attempts WHERE lead_id = ANY(%s::uuid[]) ORDER BY round, attempt_number", (ids,),
            ).fetchall():
                history.setdefault(a["lead_id"], []).append(a)
    active = camp.get("status") == "Active"
    out = []
    for r in rows:
        if r["final_status"]:
            state = r["final_status"]
        elif r["calling"]:
            state = "calling"
        elif r["next_attempt_at"]:
            state = "retry_scheduled" if active else "retry_paused"
        else:
            state = "calling"
        out.append({
            "id": r["id"], "contact_id": r["contact_id"], "name": r["name"], "phone": r["phone"],
            "attempts": r["attempts"], "round": r["round"], "max_attempts": settings_of(camp)["max_attempts"],
            "last_outcome": r["last_outcome"], "last_attempt_at": _iso_out(r["last_attempt_at"]),
            "next_attempt_at": _iso_out(r["next_attempt_at"]) if not r["final_status"] else None,
            "final_status": r["final_status"], "status": state,
            "history": [{**h, "placed_at": _iso_out(h["placed_at"]), "ended_at": _iso_out(h["ended_at"])} for h in history.get(r["id"], [])],
        })
    return {"rows": out, "total": total}


def _iso_out(value) -> str | None:
    t = parse_time(value)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None
