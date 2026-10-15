"""Inbound caller verification: who answers a call that arrives on a number with it turned on.

Normally a number is wired to its agent inside VAPI, so the agent picks up every call and this
server never hears about it until the call is over. With verification on (phone_numbers.
caller_verification_enabled) the number has NO assistant in VAPI; instead VAPI sends this server an
`assistant-request` as each call arrives and connects the call to whatever we answer:

    {"assistantId": "<agent>"}   the call is answered by the number's agent
    {"error": "<sentence>"}      the agent never starts; VAPI speaks the sentence and ends the call

The decision, in order: the number's answering hours (outside them the caller is told we are closed),
the account's balance suspension (same rule as static numbers: the shared "unavailable" assistant
answers), an agent must be assigned, then the caller is looked up (services/caller_lookup.py) and
refused unless the number is a mobile line. VAPI cannot leave a call literally unanswered; the
sentence above is the shortest way it offers to turn one away.

Answering hours (phone_numbers.answer_hours_*, services/call_hours.py) use the same per-call routing:
a number with hours switched on is routed through this server even when caller verification is off
(`server_routed`), and then only the hours rule applies. So everything below that is said about "a
verified number" holds for any server-routed number.

Fail-open rules, because refusing a real customer is worse than letting a bad call through:
a lookup that gives no verdict (provider down, timeout, bad key), a caller id that cannot be
checked (none, non-US, extension) and an unexpected error all let the call through. The audit
log (inbound_call_screenings) records which rule applied.

VAPI gives the server ~7.5 s end-to-end, and a failed request hangs the call up, so
handle_assistant_request never raises.
"""
# Entry points: handle_assistant_request (called by routers/webhooks.py), availability and the
# routing helpers (called by routers/telephony.py when a number's VAPI routing is written).
# Reads phone_numbers and ai_agents; writes inbound_call_screenings. Calls VAPI only through the
# fallback-assistant helper in routers/telephony.py.
import asyncio
import logging
from urllib.parse import urlparse

import httpx

from config import settings
from database import supabase
from services import call_hours, caller_lookup, vapi_client

logger = logging.getLogger(__name__)

# Spoken to a refused caller. Kept to one short sentence: the call is already connected while it
# plays, and every extra second is time the line is held open for a number we are turning away.
REFUSAL_MESSAGE = "Sorry, we are unable to take your call. Goodbye."
# Spoken to a caller who rings outside the number's answering hours.
CLOSED_MESSAGE = "Sorry, we are closed right now. Please call back during our opening hours. Goodbye."
# Spoken when the number cannot be served at all (unknown number, no agent assigned).
UNAVAILABLE_MESSAGE = "Sorry, this number is not taking calls right now. Goodbye."
# Shown to customers when the server is not set up for verification (details go to the log).
UNAVAILABLE_REASON = "Caller verification isn't available yet. Please contact support."
# Same, for answering hours.
HOURS_UNAVAILABLE_REASON = "Answering hours aren't available yet. Please contact support."

# Path (under PUBLIC_API_URL) VAPI is told to send a verified number's requests to.
INBOUND_WEBHOOK_PATH = "/webhooks/vapi/inbound"

# `decision` values stored in inbound_call_screenings.
ANSWERED = "answered"
REFUSED = "refused"
# `reason` values the answering-hours rule writes there (the verification rule has its own).
OUTSIDE_HOURS = "outside_hours"
WITHIN_HOURS = "within_hours"


def _public_url_usable() -> bool:
    """True when PUBLIC_API_URL names a host the voice service could reach from the internet: set,
    with a host, and not a loopback address (switching a number to a URL nobody outside can reach
    would drop every call on it)."""
    host = (urlparse(settings.public_api_url or "").hostname or "").lower()
    return bool(host) and host not in ("localhost", "0.0.0.0", "::1") and not host.startswith("127.") and not host.endswith(".localhost")


def missing_settings() -> list[str]:
    """Names of the settings that keep caller verification from being switched on (empty = none).
    For the server log only; customers are shown UNAVAILABLE_REASON."""
    return [
        name for name, ok in (
            ("VAPI_API_KEY", bool(settings.vapi_api_key)),
            ("PUBLIC_API_URL (a non-loopback address)", _public_url_usable()),
            ("CALLER_LOOKUP_CODE/CALLER_LOOKUP_API_KEY", settings.caller_lookup_configured),
        ) if not ok
    ]


def availability() -> tuple[bool, str | None]:
    """Whether this server can run caller verification, and a customer-safe reason if not.

    It needs the voice service key (to re-route the number), a public URL (for VAPI to reach us)
    and the lookup credentials. Which one is missing: missing_settings() (the toggle logs it as a
    warning when it refuses; this is also polled by the dashboard, so it stays quiet).
    """
    if missing_settings():
        return False, UNAVAILABLE_REASON
    return True, None


def routing_configured() -> bool:
    """What re-pointing a number needs: the voice service key and a reachable public URL. The
    lookup credentials are NOT needed for that (calls are then answered unchecked, but a verified
    number still sends every call to this server), so the startup re-sync only checks these."""
    return bool(settings.vapi_api_key) and _public_url_usable()


def routing_availability() -> tuple[bool, str | None]:
    """Whether this server can route a number's calls through itself, which answering hours need
    (the lookup credentials caller verification also needs are NOT required). A customer-safe
    reason when not. Quiet, like availability(): the dashboard polls it; the switch-on path logs
    which setting is missing."""
    if routing_configured():
        return True, None
    return False, HOURS_UNAVAILABLE_REASON


def server_routed(phone: dict | None) -> bool:
    """Whether VAPI asks this server on every call to this number instead of using a fixed
    assistant: caller verification OR answering hours is switched on. Every place that writes a
    number's assistant in VAPI must leave a server-routed number alone."""
    phone = phone or {}
    return bool(phone.get("caller_verification_enabled") or phone.get("answer_hours_enabled"))


# Every write of one number's routing (toggle, balance suspend/restore, receptionist changes, the
# startup re-sync) holds this lock from reading the number's state to storing the result, so two
# writers cannot interleave and leave VAPI and the database disagreeing (e.g. a toggle's VAPI
# PATCH in flight while a balance sync reads the old flag). Per event loop, because an asyncio
# lock belongs to the loop that first waits on it.
_routing_locks: dict[tuple[int, str], asyncio.Lock] = {}


def routing_lock(number_id) -> asyncio.Lock:
    """The lock serializing routing writes for one phone_numbers row."""
    key = (id(asyncio.get_running_loop()), str(number_id))
    lock = _routing_locks.get(key)
    if lock is None:
        lock = _routing_locks[key] = asyncio.Lock()
    return lock


# Overridden by tests with an httpx.MockTransport.
_PROBE_TRANSPORT: httpx.AsyncBaseTransport | None = None
_PROBE_TIMEOUT_SECONDS = 5.0


async def check_reachable() -> tuple[bool, str | None]:
    """Whether a request from the voice service would really reach this server, checked BEFORE a
    number is switched to depend on it (a number with verification on has no fixed assistant, so
    if VAPI cannot reach us every call on it is hung up).

    Posts a harmless `ping` to exactly the URL, with exactly the headers, a verified number is
    given, and expects this server's own acknowledgement back. That catches a reverse proxy that
    sends the path somewhere else (the apex host in nginx/conf.d/nexus.conf routes unknown paths to
    the frontend, which answers a POST with 405), a mistyped PUBLIC_API_URL, TLS problems and a
    secret this server would reject. Returns (True, None), or (False, a short secret-free reason).

    It runs from this server, which is not exactly VAPI's vantage point: where the backend cannot
    reach its own public address, set CALLER_VERIFICATION_SKIP_REACHABILITY_CHECK=true.
    """
    if settings.caller_verification_skip_reachability_check:
        return True, None
    try:
        block = routing_server_block()
    except ValueError:
        return False, "no_public_url"
    try:
        async with httpx.AsyncClient(timeout=_PROBE_TIMEOUT_SECONDS, transport=_PROBE_TRANSPORT) as client:
            # httpx's timeouts apply per phase (connect, each read, ...), so a server that trickles bytes
            # could hold this open: one hard deadline covers the whole exchange.
            r = await asyncio.wait_for(
                client.post(block["url"], headers=block.get("headers") or {}, json={"message": {"type": "ping"}}),
                timeout=_PROBE_TIMEOUT_SECONDS,
            )
    except Exception as e:  # noqa: BLE001 — logged by type only (messages can echo the URL)
        logger.error("Caller verification reachability check failed (%s) calling %s", type(e).__name__, block["url"])
        return False, "unreachable"
    try:
        acknowledged = r.status_code == 200 and r.json().get("received") is True
    except Exception:  # noqa: BLE001 — not JSON, or not an object
        acknowledged = False
    if not acknowledged:
        logger.error(
            "Caller verification reachability check: %s answered HTTP %s instead of this server's webhook "
            "acknowledgement. A reverse proxy is probably sending that path elsewhere (see nginx/conf.d/nexus.conf) "
            "or the webhook secret is not accepted.", block["url"], r.status_code)
        return False, f"http_{r.status_code}"
    return True, None


# Seconds to wait before each further reachability probe in the startup re-sync (the first probe
# runs at once). About six minutes in all: long enough for a proxy that comes up after the backend.
RESYNC_RETRY_DELAYS = (2, 5, 10, 20, 30, 60, 60, 60, 60, 60)


async def reconcile_verified_routing(*, retry_delays=RESYNC_RETRY_DELAYS) -> dict:
    """Re-point every number that has verification on at THIS server's current address and secret.

    A number is given the URL and secret once, when verification is switched on, and VAPI keeps
    them. If PUBLIC_API_URL or VAPI_WEBHOOK_SECRET changes later (settings only change on a
    restart), or a toggle half-failed, the number would send every call to an address or secret
    that no longer works, silently, while the dashboard still says "on". Running this at startup
    puts them right. Until it has run, calls on those numbers still reach the OLD address/secret
    (so right after a secret rotation they are refused for the seconds this takes).

    It needs only the voice service key and a public URL (not the lookup credentials: without
    them calls are answered unchecked, but still routed through this server). It waits for this
    server to answer at its public address first, retrying with backoff, and never re-points at an
    address that does not answer. Each number is re-read under its routing lock right before the
    push, so a toggle made while this waited is respected.

    Returns a summary: {"skipped": why} or {"repointed": n, "failed": m, "unchanged": k}.
    """
    # Every server-routed number: verification on, or answering hours on (two queries, one per
    # reason, merged by id).
    rows_by_id: dict = {}
    for column in ("caller_verification_enabled", "answer_hours_enabled"):
        for r in supabase.table("phone_numbers").select("id").eq(column, True).execute().data or []:
            rows_by_id[r["id"]] = r
    rows = list(rows_by_id.values())
    if not rows:
        return {"skipped": "no verified numbers"}
    if not routing_configured():
        logger.warning("Caller verification: %d number(s) have it on but were not re-pointed: VAPI_API_KEY or a "
                       "non-loopback PUBLIC_API_URL is missing", len(rows))
        return {"skipped": "not configured"}

    why = None
    for wait in (0, *retry_delays):
        if wait:
            await asyncio.sleep(wait)
        reachable, why = await check_reachable()
        if reachable:
            break
    else:
        logger.error("Caller verification: %d number(s) left as they are, this server is not reachable at its "
                     "public address (%s)", len(rows), why)
        return {"skipped": f"unreachable ({why})"}

    repointed = failed = unchanged = 0
    for r in rows:
        async with routing_lock(r["id"]):
            now = (
                supabase.table("phone_numbers").select("vapi_phone_id, caller_verification_enabled, answer_hours_enabled")
                .eq("id", r["id"]).maybe_single().execute().data
            )
            if not now or not server_routed(now) or not now.get("vapi_phone_id"):
                unchanged += 1  # switched off (or released) while this waited: leave it alone
                continue
            try:
                await vapi_client.update_phone_number(now["vapi_phone_id"], verified_routing_payload())
                repointed += 1
            except Exception:  # noqa: BLE001 — one number must not stop the rest
                failed += 1
                logger.exception("Caller verification: could not re-point number %s", r["id"])
    logger.info("Caller verification: re-pointed %d number(s), %d failed, %d no longer verified",
                repointed, failed, unchanged)
    return {"repointed": repointed, "failed": failed, "unchanged": unchanged}


def routing_server_block() -> dict:
    """The VAPI `server` block that sends a number's per-call requests to this backend.

    The shared secret rides in an X-Vapi-Secret header (a phone number's `server` object has
    `headers`, not an inline `secret`); routers/webhooks.py accepts that header.
    """
    if not settings.public_api_url:
        raise ValueError("PUBLIC_API_URL is not set")
    block: dict = {"url": settings.public_api_url.rstrip("/") + INBOUND_WEBHOOK_PATH}
    if settings.vapi_webhook_secret:
        block["headers"] = {"X-Vapi-Secret": settings.vapi_webhook_secret}
    return block


def verified_routing_payload() -> dict:
    """PATCH /phone-number body for a number with verification ON: no fixed assistant (so VAPI
    asks this server on every call) and the server to ask."""
    return {"assistantId": None, "server": routing_server_block()}


# ── Per-call decision ──


def _obj(value) -> dict:
    """`value` if it is a JSON object, else an empty dict, so a malformed field in a request we
    do not control reads as "absent" instead of raising."""
    return value if isinstance(value, dict) else {}


def _phone_number_id(msg: dict, call: dict) -> str | None:
    """VAPI's id for the number that was dialed (phone_numbers.vapi_phone_id)."""
    found = (
        call.get("phoneNumberId")
        or _obj(msg.get("phoneNumber")).get("id")
        or msg.get("phoneNumberId")
    )
    return found if isinstance(found, str) and found else None


def _caller_number(msg: dict, call: dict) -> str | None:
    """The CALLER's number. On an inbound call VAPI reports it as call.customer.number;
    message.phoneNumber.number is OUR number and must never be mistaken for it."""
    return (
        _obj(call.get("customer")).get("number")
        or _obj(msg.get("customer")).get("number")
        or _obj(call.get("from")).get("phoneNumber")
    )


def _find_phone(vapi_phone_id: str | None) -> dict | None:
    """The phone_numbers row for a VAPI phone id, or None."""
    if not vapi_phone_id:
        return None
    rows = (
        supabase.table("phone_numbers")
        .select("id, user_id, number, agent_id, caller_verification_enabled, suspended_for_balance, "
                "answer_hours_enabled, answer_hours_timezone, answer_hours_days, answer_hours_start, answer_hours_end")
        .eq("vapi_phone_id", vapi_phone_id)
        .limit(1)
        .execute()
        .data
    )
    return rows[0] if rows else None


def _agent_assistant_id(phone: dict) -> str | None:
    """VAPI assistant of the agent assigned to this number, or None when there is no agent or it
    is not set up in VAPI."""
    if not phone.get("agent_id"):
        return None
    rows = (
        supabase.table("ai_agents")
        .select("vapi_assistant_id")
        .eq("id", phone["agent_id"])
        .eq("user_id", phone["user_id"])
        .limit(1)
        .execute()
        .data
    )
    return (rows[0].get("vapi_assistant_id") or None) if rows else None


async def _fallback_assistant_id() -> str | None:
    """The shared "unavailable" assistant used while an account's balance is empty."""
    # Imported here: routers/telephony.py imports this module, so a top-level import would be circular.
    from routers.telephony import _get_or_create_fallback_assistant_id

    return await _get_or_create_fallback_assistant_id()


# The fallback assistant is normally cached (a database read). If it still has to be CREATED in
# VAPI during a live call, that may only take this long: VAPI hangs up after ~7.5 s.
FALLBACK_BUDGET_SECONDS = 2.0
# A creation already under way, shared by concurrent calls so they do not each create one.
_fallback_task: "asyncio.Future | None" = None


async def _fallback_within_budget() -> str | None:
    """The fallback assistant id, or None if it cannot be had within FALLBACK_BUDGET_SECONDS.
    A creation that overruns keeps going in the background (and caches its id for the next call)."""
    global _fallback_task
    task = _fallback_task
    if task is None or task.done() or task.get_loop() is not asyncio.get_running_loop():
        task = _fallback_task = asyncio.ensure_future(_fallback_assistant_id())
        task.add_done_callback(caller_lookup._discard_outcome)
    done, _ = await asyncio.wait({task}, timeout=FALLBACK_BUDGET_SECONDS)
    if not done:
        logger.warning("Fallback assistant not available within %.1fs; refusing the call politely",
                       FALLBACK_BUDGET_SECONDS)
        return None
    if task.cancelled() or task.exception() is not None:
        logger.warning("Fallback assistant could not be obtained: %s",
                       "cancelled" if task.cancelled() else type(task.exception()).__name__)
        return None
    return task.result()


def _record(phone: dict, call: dict, caller: str | None, answered: bool, reason: str,
            line_type: str | None = None, detail: str | None = None) -> None:
    """Write one audit row. Best-effort: a logging failure must never change the decision.

    For an answered call it also records the agent that answered: that row is how the call is
    later attributed (logged and billed) when VAPI reports it without an assistant id
    (see answered_calls)."""
    try:
        call_id = call.get("id")
        supabase.table("inbound_call_screenings").insert({
            "user_id": phone["user_id"],
            "phone_number_id": phone["id"],
            "vapi_call_id": str(call_id)[:128] if call_id else None,
            "caller_number": (str(caller)[:64] if caller else None),
            "decision": ANSWERED if answered else REFUSED,
            "reason": reason,
            "line_type": line_type,
            "detail": detail,
            "agent_id": phone.get("agent_id") if answered else None,
        }).execute()
    except Exception:  # noqa: BLE001
        logger.exception("Could not record the caller-verification result for call %s", call.get("id"))


def answered_calls(vapi_call_ids) -> dict[str, dict]:
    """{vapi_call_id: {"user_id", "agent_id"}} for the calls THIS server answered with a number's
    agent after checking the caller (an inbound_call_screenings row with decision "answered").

    This is how a call is attributed when VAPI reports it with no assistant id (it can leave that
    empty when the assistant was chosen per call): by what we decided when the call arrived, not
    by the number's flag now (switching verification off mid-call would otherwise make the call
    vanish unbilled). Refused calls, calls served by the shared "unavailable" assistant and calls
    still being screened have no such row, so they are never logged or billed this way."""
    ids = [i for i in vapi_call_ids if isinstance(i, str) and i]
    if not ids:
        return {}
    rows = (
        supabase.table("inbound_call_screenings")
        .select("vapi_call_id, user_id, agent_id")
        .in_("vapi_call_id", ids)
        .eq("decision", ANSWERED)
        .execute()
        .data
        or []
    )
    # The agent may have been deleted since the call (the audit row keeps its id): the call is still
    # the account's, just not linked to an agent (conversations.agent_id must name an existing one).
    agent_ids = list({r["agent_id"] for r in rows if r.get("agent_id")})
    existing = set()
    if agent_ids:
        found = supabase.table("ai_agents").select("id").in_("id", agent_ids).execute().data or []
        existing = {str(a["id"]) for a in found}
    return {
        r["vapi_call_id"]: {"user_id": r["user_id"],
                            "agent_id": r["agent_id"] if str(r.get("agent_id")) in existing else None}
        for r in rows
    }


async def _screen(caller: str | None) -> tuple[bool, str, str | None, str | None]:
    """Apply the verification rule to a caller id: (answer?, reason, line_type, detail)."""
    parsed = caller_lookup.parse_caller_number(caller)
    if parsed.kind == "none":
        return True, "no_caller_number", None, None
    if parsed.kind in ("foreign", "other"):
        # The provider only covers US numbers: there is nothing to verify against.
        return True, "unverifiable_number", None, parsed.kind
    if parsed.kind == "invalid_us":
        return False, "invalid_number", None, None

    result = await caller_lookup.lookup_mobile(parsed.national)
    if result.outcome == "mobile":
        return True, "mobile_verified", result.line_type, None
    if result.outcome == "not_mobile":
        return False, "not_mobile", result.line_type, result.detail
    return True, "lookup_unavailable", None, result.detail


async def _decide(payload: dict) -> dict:
    """The routing decision for one assistant-request; see the module docstring for the order."""
    msg = _obj(payload.get("message"))
    call = _obj(msg.get("call"))
    phone = _find_phone(_phone_number_id(msg, call))
    if not phone:
        logger.warning("assistant-request for a number we do not know (call %s)", call.get("id"))
        return {"error": UNAVAILABLE_MESSAGE}

    caller = _caller_number(msg, call)

    # Answering hours come first: a closed number tells the caller so, whatever else is true of the
    # account. A hours setting that cannot be read leaves the call open (never drop a real customer).
    hours_on = call_hours.enabled(phone, call_hours.NUMBER)
    if hours_on and not call_hours.is_open(phone, call_hours.NUMBER, if_unreadable=True):
        _record(phone, call, caller, False, OUTSIDE_HOURS)
        logger.info("Refused call %s: outside answering hours", call.get("id"))
        return {"error": CLOSED_MESSAGE}

    # Same rule as a statically routed number: an account with no balance is served by the shared
    # "unavailable" assistant. The flag is kept current by sync_inbound_routing_for_balance.
    if phone.get("suspended_for_balance"):
        fallback = await _fallback_within_budget()
        return {"assistantId": fallback} if fallback else {"error": UNAVAILABLE_MESSAGE}

    assistant_id = _agent_assistant_id(phone)
    if not assistant_id:
        return {"error": UNAVAILABLE_MESSAGE}

    # The number's flag is the source of truth. If it is off (VAPI still asking us after a
    # half-finished toggle, or only the hours rule applies) the call goes to the agent, unscreened.
    if not phone.get("caller_verification_enabled"):
        if hours_on:
            # Recorded so the call can be attributed (logged and billed) even when VAPI reports it
            # without an assistant id: see answered_calls.
            _record(phone, call, caller, True, WITHIN_HOURS)
        return {"assistantId": assistant_id}

    if not caller:
        # A genuine inbound call carries a caller id; seeing none on EVERY call would mean VAPI's
        # payload differs from what _caller_number reads, and verification would silently let
        # everyone through. Log the payload's shape (key names only, never values) so that is
        # diagnosable from the server log.
        logger.warning("assistant-request carried no caller number (call keys: %s; message keys: %s)",
                       sorted(call), sorted(msg))
    answer, reason, line_type, detail = await _screen(caller)
    _record(phone, call, caller, answer, reason, line_type, detail)
    if answer:
        return {"assistantId": assistant_id}
    logger.info("Refused call %s: %s", call.get("id"), reason)
    return {"error": REFUSAL_MESSAGE}


def _route_to_agent_unscreened(payload: dict) -> dict:
    """Last resort after an unexpected error: connect the call to the number's agent."""
    msg = _obj(payload.get("message"))
    phone = _find_phone(_phone_number_id(msg, _obj(msg.get("call"))))
    # Never hand a zero-balance account's caller to its real agent, even on this error path.
    if phone and phone.get("suspended_for_balance"):
        return {"error": UNAVAILABLE_MESSAGE}
    # Nor outside the number's answering hours: failing open must not mean answering a closed line.
    if phone and not call_hours.is_open(phone, call_hours.NUMBER, if_unreadable=True):
        return {"error": CLOSED_MESSAGE}
    assistant_id = _agent_assistant_id(phone) if phone else None
    return {"assistantId": assistant_id} if assistant_id else {"error": UNAVAILABLE_MESSAGE}


async def handle_assistant_request(payload: dict) -> dict:
    """VAPI's `assistant-request` for a call arriving on a verified number: the JSON response.

    Never raises: VAPI hangs the call up if this server errors or is slow, so an unexpected
    failure connects the call to the number's agent (fail-open) instead of dropping it.
    """
    try:
        return await _decide(payload)
    except Exception:  # noqa: BLE001
        logger.exception("assistant-request handling failed; connecting the call unscreened")
        try:
            return _route_to_agent_unscreened(payload)
        except Exception:  # noqa: BLE001
            logger.exception("assistant-request fallback failed too")
            return {"error": UNAVAILABLE_MESSAGE}
