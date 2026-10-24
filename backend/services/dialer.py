"""
The dialing engine: ONE module decides every outbound-campaign placement.

A campaign places its calls according to its dialing strategy (services/dial_settings.py):
  Sequential  one call at a time; the next goes out when the open one ends (+ the delay after it ENDS)
  Concurrent  N calls kept open at once; a call that ends is refilled at once (delay = gap between starts)
  Paced       calls started at a steady rate, 60 / calls-per-minute seconds apart (delay: the slower one wins)

The database is the queue (there is no in-memory queue), so a restart loses nothing:
  - a campaign's PASS over its list is `dial_running`; its place in it is `dial_seq` (contacts.seq is the
    upload order) with `dial_cursor` (the same contact's id) kept in lockstep for the screens that show it
  - redials (services/call_retry.py) are leads whose `next_attempt_at` is due. They are tier 0 of the one
    queue: due redials first, then fresh numbers, all under the SAME slots, rate, delay and caps, so
    "retries follow the strategy" is structural.

How it runs
  dispatcher_loop()   wakes on `nudge()` (a call ended, Start / Pause / Resume, a settings change), at the
                      earliest `dial_next_at`, or every `dialer_tick_seconds`, and runs dispatch_once().
  dispatch_once()     one candidate query, one grouped count of open calls, the account / platform limits, then
                      capacity() per campaign (campaigns of one account share the cap fairly); every campaign
                      with room is served by a tick() of its own.
  tick()              claims the campaign (run_token, stale after 60 s), then loops: read the row, check the
                      calling hours, check the setup (agent, number, account, wallet), work out how many calls
                      fit, pick the next numbers (redials first), place them (staggered), save the place.
  gate()              called from routers/telephony._place_call right before a call takes its attempt, with no
                      `await` in between: re-reads the campaign (paused? hours? same list?), counts the open
                      calls and hands out the lowest free slot, so a Pause or a cap bites per placement.

Everything is driven by an injectable clock (`now=`); the decision logic never reads the wall clock itself
(the default clock is `_now()`, one place tests can patch). The pure parts (capacity, group_size, paced_next,
backoff_next, split_fresh, cursor_prefix) take their inputs as arguments and are unit tested on their own.

Kill switch: DIALER_TICK_SECONDS=0 disables the loop (main._start_dialer); campaigns then advance only at the
60 s sweep (services/campaign_scheduler.py), a degraded mode.
"""
import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from psycopg.types.json import Json

from config import settings
from db_pg import _get_pool, _json_row
from database import supabase
from services import call_hours, call_retry, dial_limits, dial_settings, vapi_client, whitelist_service

logger = logging.getLogger(__name__)

# ── tuning (seconds unless named otherwise) ──
CLAIM_STALE_S = 60              # a claim not refreshed for this long is taken over (its tick crashed)
TICK_TIMEOUT_S = 45             # one tick is cut off after this long
TICK_BUDGET_S = 15              # a tick that has been placing this long hands over (and nudges itself)
TICK_MAX_ITERATIONS = 500
SETUP_RETRY_S = 15              # a campaign that cannot dial (agent, number, account, wallet) looks again after this
BACKOFF_S = 15                  # a placement that could not take its slot / attempt / capacity: try again after this
SCREENING_BACKOFF_S = 30        # the do-not-call screening is down
NUMBER_BACKOFF_S = 60           # the provider says this number reached its daily call limit
CAPACITY_BACKOFF_S = (30, 120)  # first and longest wait after the provider refused a call for lack of capacity
LEARNED_CAP_S = 300             # how long "the provider is full at N calls" is remembered
BREAKER_FAILS = 5               # consecutive provider errors in one pass that park the campaign
FETCH_ROUNDS = 4                # fresh-number fetches per pick
RECONCILE_MIN_AGE_S = 8         # an open call younger than this is left to its own end report
RECONCILE_UNLISTED_AFTER_S = 60 # a call missing from the provider's recent list this long after it was placed is asked about by id
RECONCILE_MAX_LOOKUPS = 10      # individual lookups of unlisted calls per cycle
RECONCILE_POISON_AFTER = 3      # failed imports of an ended call after which its attempt is closed directly
RECONCILE_CONCURRENCY = 5       # ended calls imported at the same time (one slow import never holds up the others)
RECONCILE_COST_WAIT_S = 20      # an ended call whose record has no cost yet is imported only once it ended this long ago
RECONCILE_LOOKUP_EVERY_S = 30   # an unlisted call is asked about by id at most this often (so the lookups rotate)
NOTIFY_STALLS = ("agent", "number", "blocked", "balance", "provider_error")
# Every stall the engine can set. A tick that is about to place a call (or a Start / Resume) clears a stale one.
RECOVERED_STALLS = ("agent", "number", "blocked", "balance", "provider_error", "provider_limit", "screening")
NOTIFY_DEDUP_S = 600            # the owner is not told about the same stall again within this long (a flip around the boundary)
WAKE_SLACK_S = 0.02             # a wake is armed this much after its moment, so the clock is surely past it

# The number's key in SQL: the same rule as call_retry.phone_key (last 10 digits, else the trimmed text).
_PHONE_KEY_SQL = (r"CASE WHEN regexp_replace(c.phone, '\D', '', 'g') <> '' "
                  r"THEN right(regexp_replace(c.phone, '\D', '', 'g'), 10) ELSE btrim(c.phone) END")


# ── clock and small helpers ──

def _now() -> datetime:
    """The engine's clock (UTC). The one place the wall clock is read; tests patch this module's `datetime`."""
    return datetime.now(timezone.utc)


def _iso(moment: datetime) -> str:
    return call_retry.iso(moment)


def _iso_out(value) -> str | None:
    """A timestamp as the API shows it ("...Z" to the second), or None."""
    t = call_retry.parse_time(value)
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else None


def _q(sql: str, params=()) -> list[dict]:
    """Run one statement on the pool; rows as JSON-friendly dicts (uuid -> str, datetime -> ISO string)."""
    with _get_pool().connection() as conn:
        cur = conn.execute(sql, params)
        return [_json_row(r) for r in cur.fetchall()] if cur.description else []


def _val(v):
    """A value as a statement parameter: dicts become jsonb, datetimes ISO strings."""
    if isinstance(v, dict):
        return Json(v)
    if isinstance(v, datetime):
        return _iso(v)
    return v


# ── pure parts ──

def capacity(row: dict, counts: dict, limits: dict | None, now: datetime, last_end=None):
    """How many calls the campaign may place right now: (n, reason, wake_at).

    `row` is the campaign (dial_* columns), `counts` {"campaign", "owner", "platform"}: calls open right now
    (a call still being placed counts, so do legacy calls without a slot), `limits` the account's limits
    (services/dial_limits.limits_for: account_limit / platform_limit, None = no cap), `last_end` when the
    campaign's latest call ended (Sequential delay). `reason` says why n is 0: "spacing" (a wait, until
    `wake_at`), "open" (the strategy's own limit is reached), "account" or "platform" (a cap is full); it is
    None when n > 0. A back-off or pacing wait stored in `dial_next_at` holds back every strategy.

      Sequential  1 - open; with delay D the next call waits until the last one ended + D
      Concurrent  N - open (N from dial_concurrent_calls)
      Paced       1 per group (the rate itself is dial_next_at, see paced_next); at most
                  settings.dialer_paced_max_open open at once as a safety limit
    then the account and platform caps (free = cap - open) cut that further."""
    s = dial_settings.describe(row)
    strategy = s["strategy"]
    c_open = int(counts.get("campaign", 0))
    o_open = int(counts.get("owner", 0))
    p_open = int(counts.get("platform", 0))
    next_at = call_retry.parse_time((row or {}).get("dial_next_at"))
    if next_at and now < next_at:
        return 0, "spacing", next_at
    if strategy == "sequential":
        if c_open >= 1:
            return 0, "open", None
        ended = call_retry.parse_time(last_end)
        if s["delay_seconds"] and ended:
            due = ended + timedelta(seconds=s["delay_seconds"])
            if now < due:
                return 0, "spacing", due
        n = 1
    elif strategy == "concurrent":
        n = s["concurrent_calls"] - c_open
        if n <= 0:
            return 0, "open", None
    else:
        if c_open >= int(settings.dialer_paced_max_open):
            return 0, "open", None
        n = 1
    reason = None
    for key, used, why in (("account_limit", o_open, "account"), ("platform_limit", p_open, "platform")):
        cap = (limits or {}).get(key)
        if cap is not None and max(0, int(cap) - used) < n:
            n, reason = max(0, int(cap) - used), why
    if n <= 0:
        return 0, reason, None
    return n, None, None


def group_size(row: dict, n: int, batch_size: int) -> int:
    """How many calls start together in one group: `n` up to `batch_size`, but 1 whenever a spacing or a delay
    applies (Paced, or a delay between calls), so every call honours its own gap."""
    if n <= 0:
        return 0
    s = dial_settings.describe(row)
    if s["strategy"] == "paced" or s["delay_seconds"] > 0:
        return 1
    return max(1, min(n, int(batch_size)))


def paced_next(prev, t: datetime, spacing_s: float) -> datetime:
    """The next Paced call time after a call was placed at `t`. `prev` is the grid slot that call was due at
    (the stored dial_next_at, or None). The grid stays anchored on it while the call is less than one spacing
    late, so 10 per minute is exactly 6.000 s apart with no drift; a call a full spacing or more late (after a
    pause, the hours, an outage) re-anchors at `t`, so there is never a catch-up burst."""
    gap = timedelta(seconds=spacing_s)
    prev = call_retry.parse_time(prev)
    base = prev if prev is not None and (t - prev) < gap else t
    return base + gap


def backoff_next(previous) -> int:
    """The wait (seconds) after the provider refused a call for lack of capacity: 30, then doubling up to 120."""
    first, longest = CAPACITY_BACKOFF_S
    try:
        previous = int(previous or 0)
    except (TypeError, ValueError):
        previous = 0
    return first if previous <= 0 else min(longest, previous * 2)


def split_fresh(rows: list[dict], taken_keys: set, seen_keys: set | None = None) -> list[dict]:
    """The fresh-number candidates `rows` (contacts in seq order) as queue items, each marked `dup` when its
    number repeats earlier in this batch / `seen_keys` or was already tried in this pass (`taken_keys`). A
    duplicate is skipped, never called: a number is dialed once per pass. `seen_keys` is updated."""
    seen = seen_keys if seen_keys is not None else set()
    out = []
    for r in rows:
        key = call_retry.phone_key(r.get("phone"))
        dup = key in seen or key in taken_keys
        seen.add(key)
        out.append({"kind": "fresh", "contact": r, "key": key, "dup": dup, "final": dup})
    return out


def cursor_prefix(items: list[dict]):
    """The last item of the contiguous run of `final` items from the start of `items` (fresh numbers in seq
    order): the campaign's place moves up to it and no further, so a number whose call could not be placed yet
    is picked again."""
    last = None
    for it in items:
        if not it.get("final"):
            break
        last = it
    return last


# ── in-process state ──

_serving: set = set()           # campaigns a tick is running for in THIS process
_tasks: set = set()             # ticks started by the background loop (kept so they are not garbage collected)
_loop = None                    # the loop dispatcher_loop() runs on (set there); None = no loop, nudge is a no-op
_wake = None                    # asyncio.Event created inside dispatcher_loop, never at import
_last_dispatch = None           # time.monotonic() of the last dispatch_once
_logged_capacity_body = False   # the first capacity rejection's body is logged once per process


def nudge() -> None:
    """Wake the dispatcher now (a call ended, Start / Pause / Resume, a settings change). Safe from any thread;
    does nothing when no dispatcher loop runs (tests, kill switch)."""
    loop, ev = _loop, _wake
    if loop is None or ev is None:
        return
    try:
        if loop.is_closed():
            return
        loop.call_soon_threadsafe(ev.set)
    except RuntimeError:
        pass


def _arm_wake(loop, ev, delay: float) -> None:
    """Runs on the dispatcher's loop: set the wake event `delay` seconds from now."""
    loop.call_later(delay, ev.set)


def schedule_wake(at, t: datetime | None = None) -> bool:
    """Make the dispatcher loop wake at `at` (a campaign's next call is due then): a tick stores `dial_next_at` AFTER
    the loop worked out how long to sleep, so without this the loop would sleep its whole interval past it (Paced 60
    a minute would place 30, a one second delay one call in two). `t` is the clock the tick used (None = now). Safe
    from any thread; does nothing (False) when no dispatcher loop runs (tests, kill switch)."""
    loop, ev = _loop, _wake
    if loop is None or ev is None or at is None:
        return False
    delay = max(0.0, (at - (t or _now())).total_seconds()) + WAKE_SLACK_S
    try:
        if loop.is_closed():
            return False
        loop.call_soon_threadsafe(_arm_wake, loop, ev, delay)
    except RuntimeError:
        return False
    return True


def _on_attempt_finished(attempt) -> None:
    """call_retry.attempt_finished_hooks entry: a call ended, so a slot may be free."""
    nudge()


# Registered once, even if the module is reloaded.
call_retry.attempt_finished_hooks[:] = [h for h in call_retry.attempt_finished_hooks
                                        if getattr(h, "__name__", "") != "_on_attempt_finished"]
call_retry.attempt_finished_hooks.append(_on_attempt_finished)


def ready() -> bool:
    """True when the database has every column the engine needs (migrate.dialing_ready)."""
    import migrate

    return migrate.dialing_ready()


def startup() -> None:
    """At boot: forget every claim a previous process left behind. Safe because the Dockerfile runs ONE worker; if
    workers are ever added, drop this."""
    try:
        _q("UPDATE public.outbound_campaigns SET run_token = NULL, run_heartbeat_at = NULL WHERE run_token IS NOT NULL")
    except Exception:  # noqa: BLE001
        logger.exception("could not clear the old dialing claims")


# ── database helpers ──

def _claim(campaign_id: str, t: datetime, token: str) -> dict | None:
    """Take the campaign for one tick: only while it is Active and nobody holds it (or the holder has not been
    heard from for CLAIM_STALE_S). Returns the campaign row, or None."""
    rows = _q(
        "UPDATE public.outbound_campaigns SET run_token = %s::uuid, run_heartbeat_at = %s::timestamptz "
        "WHERE id = %s::uuid AND status = 'Active' AND (run_token IS NULL OR run_heartbeat_at IS NULL "
        f"OR run_heartbeat_at < %s::timestamptz - interval '{CLAIM_STALE_S} seconds') RETURNING *",
        (token, _iso(t), campaign_id, _iso(t)))
    return rows[0] if rows else None


def _release(campaign_id: str, token: str) -> None:
    _q("UPDATE public.outbound_campaigns SET run_token = NULL, run_heartbeat_at = NULL "
       "WHERE id = %s::uuid AND run_token = %s::uuid", (campaign_id, token))


def _read(campaign_id: str, token: str | None = None) -> dict | None:
    """The campaign row as it is now (when `token` is given, only while that tick still holds the claim)."""
    if token:
        rows = _q("SELECT * FROM public.outbound_campaigns WHERE id = %s::uuid AND run_token = %s::uuid", (campaign_id, token))
    else:
        rows = _q("SELECT * FROM public.outbound_campaigns WHERE id = %s::uuid", (campaign_id,))
    return rows[0] if rows else None


def _save(campaign_id: str, token: str, fields: dict, list_id="__any__") -> bool:
    """Write `fields` on the campaign; only if this tick still holds the claim (and, when `list_id` is given, the
    campaign still has that list). False = the claim is gone: the tick must stop."""
    cols = list(fields)
    sql = ("UPDATE public.outbound_campaigns SET " + ", ".join(f"{c} = %s" for c in cols)
           + " WHERE id = %s::uuid AND run_token = %s::uuid")
    params = [_val(fields[c]) for c in cols] + [campaign_id, token]
    if list_id != "__any__":
        sql += " AND list_id IS NOT DISTINCT FROM %s::uuid"
        params.append(list_id)
    return bool(_q(sql + " RETURNING id", params))


def _open_counts(owner_id: str, campaign_id: str) -> dict:
    """Open calls right now: this campaign's, the account's and the whole platform's."""
    r = _q("SELECT count(*) FILTER (WHERE campaign_id = %s::uuid) AS campaign, "
           "count(*) FILTER (WHERE user_id = %s::uuid) AS owner, count(*) AS platform "
           "FROM public.campaign_attempts WHERE ended_at IS NULL", (campaign_id, owner_id))[0]
    return {"campaign": int(r["campaign"]), "owner": int(r["owner"]), "platform": int(r["platform"])}


def _last_end(campaign_id: str):
    rows = _q("SELECT max(ended_at) AS t FROM public.campaign_attempts WHERE campaign_id = %s::uuid AND ended_at IS NOT NULL",
              (campaign_id,))
    return rows[0]["t"] if rows else None


def _fresh_sql(row: dict, select: str, tail: str, limit: int | None = None) -> list[dict]:
    """Contacts of the campaign's list after its place in the pass (seq order; `dial_legacy_cursor` only for a pass
    that was open before the engine existed)."""
    params = [row["user_id"], row["list_id"], row.get("dial_seq"), row.get("dial_legacy_cursor"), row.get("dial_legacy_cursor")]
    sql = (f"SELECT {select} FROM public.contacts WHERE user_id = %s::uuid AND list_id = %s::uuid AND phone IS NOT NULL "
           "AND seq > coalesce(%s::bigint, 0) AND (%s::uuid IS NULL OR id > %s::uuid) " + tail)
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    return _q(sql, params)


def fresh_left(row: dict) -> int:
    """How many numbers of the pass are still to be handed out."""
    if not row.get("list_id"):
        return 0
    return int(_fresh_sql(row, "count(*) AS n", "")[0]["n"])


def _pass_keys(campaign_id: str, pass_started, keys: list[str]) -> set:
    """Of `keys`, the numbers this campaign already called (or tried) in the current pass."""
    started = call_retry.parse_time(pass_started)
    if not started or not keys:
        return set()
    rows = _q("SELECT DISTINCT phone_key FROM public.campaign_attempts WHERE campaign_id = %s::uuid "
              "AND placed_at >= %s::timestamptz AND phone_key = ANY(%s)", (campaign_id, _iso(started), keys))
    return {r["phone_key"] for r in rows}


# ── results of a tick ──

@dataclass
class TickResult:
    """What one tick did (the Start / Resume answer and the redial sweep's counts are built from it)."""
    claimed: bool = True
    skipped: str | None = None          # why nothing ran: "busy" (another tick holds the campaign) / "not_active"
    stopped: str | None = None          # why it ended: hours, paused, finished, budget, limit, stalled, breaker, ...
    placed: int = 0                     # fresh calls placed
    redials_placed: int = 0
    errors: int = 0
    error_details: list = field(default_factory=list)
    suppressed: int = 0
    suppressed_details: list = field(default_factory=list)
    already_on_call: int = 0            # numbers skipped: on another call right now, or a duplicate in the pass
    duplicates: int = 0
    redials: dict = field(default_factory=lambda: {"busy": 0, "failed": 0, "suppressed": 0, "max_attempts": 0,
                                                    "cancelled": 0, "waiting": 0})
    finished: bool = False              # the pass ended (every number handed out)
    parked: bool = False                # the hours closed and the campaign was parked Paused
    restored: bool = False              # the hours closed before the first call of this Start: it is as it was
    next_open_at: datetime | None = None
    remaining: int | None = None
    stall: str | None = None
    wake_at: datetime | None = None     # when the dispatcher loop must look at this campaign again (a spacing / delay wait)

    def add_error(self, phone, error) -> None:
        self.errors += 1
        if len(self.error_details) < 5:
            self.error_details.append({"phone": phone, "error": error or "unknown"})

    def add_suppressed(self, phone, reason) -> None:
        self.suppressed += 1
        if len(self.suppressed_details) < 5:
            self.suppressed_details.append({"phone": phone, "reason": reason or "Suppressed"})


# ── the per-placement gate ──

def gate(campaign_id: str, token: str, list_id, t: datetime, limits: dict | None) -> dict:
    """The last check before a call takes its attempt (called by _place_call, with no `await` between this and
    begin_attempt, so the caps are exact in this process). Returns {"stop": reason} (paused / hours / capacity) or
    {"strategy", "slot", "batch", "settings": the campaign row as it is now}. It refreshes the claim's heartbeat
    and reads the campaign again, so a Pause, a changed list, a closed hour or an edited strategy bites on the very
    next placement, not on the next batch."""
    rows = _q("UPDATE public.outbound_campaigns SET run_heartbeat_at = %s::timestamptz WHERE id = %s::uuid "
              "AND run_token = %s::uuid AND status = 'Active' AND list_id IS NOT DISTINCT FROM %s::uuid RETURNING *",
              (_iso(t), campaign_id, token, list_id))
    if not rows:
        return {"stop": "paused"}
    row = rows[0]
    if not call_hours.is_open(row, call_hours.CAMPAIGN, t, if_unreadable=False):
        return {"stop": "hours"}
    c = _q("SELECT count(*) FILTER (WHERE campaign_id = %s::uuid) AS camp, count(*) AS owner, "
           "coalesce(array_agg(dial_slot) FILTER (WHERE campaign_id = %s::uuid AND dial_slot IS NOT NULL), '{}') AS slots "
           "FROM public.campaign_attempts WHERE user_id = %s::uuid AND ended_at IS NULL",
           (campaign_id, campaign_id, row["user_id"]))[0]
    camp_open, owner_open, used = int(c["camp"]), int(c["owner"]), set(c["slots"] or [])
    s = dial_settings.describe(row)
    strategy = s["strategy"]
    slot = batch = None
    if strategy == "sequential":
        if camp_open >= 1:
            return {"stop": "capacity"}
        slot = 1
    elif strategy == "concurrent":
        if camp_open >= s["concurrent_calls"]:
            return {"stop": "capacity"}
        slot = next((i for i in range(1, s["concurrent_calls"] + 1) if i not in used), None)
        if slot is None:
            return {"stop": "capacity"}
        batch = int(row.get("dial_batch_seq") or 0) + 1
    else:
        if camp_open >= int(settings.dialer_paced_max_open):
            return {"stop": "capacity"}
        batch = int(t.timestamp() // 60)
    limits = limits or {}
    if limits.get("account_limit") is not None and owner_open >= int(limits["account_limit"]):
        return {"stop": "capacity"}
    if limits.get("platform_limit") is not None:
        platform_open = int(_q("SELECT count(*) AS n FROM public.campaign_attempts WHERE ended_at IS NULL")[0]["n"])
        if platform_open >= int(limits["platform_limit"]):
            return {"stop": "capacity"}
    return {"strategy": strategy, "slot": slot, "batch": batch, "settings": row}


# ── queue pickers ──

def _pick_redials(row: dict, t: datetime, need: int, res: TickResult, skip: set = frozenset()) -> list[dict]:
    """Tier 0: up to `need` due redials of the campaign, oldest first, numbers on another call right now left out
    (they stay due and nothing hot-loops). The redial rules run here: retrying switched off, a contact that left
    the list and a number at its maximum are settled without a call (they take no budget)."""
    leads = _q(
        "SELECT l.* FROM public.campaign_leads l LEFT JOIN public.contacts c ON c.id = l.contact_id "
        "WHERE l.campaign_id = %s::uuid AND l.final_status IS NULL AND l.next_attempt_at IS NOT NULL "
        "AND l.next_attempt_at <= %s::timestamptz "
        "AND NOT EXISTS (SELECT 1 FROM public.campaign_attempts a WHERE a.user_id = l.user_id AND a.ended_at IS NULL "
        f"AND a.phone_key = {_PHONE_KEY_SQL}) "
        "ORDER BY l.next_attempt_at, l.id LIMIT %s", (row["id"], _iso(t), need * 3 + 10))
    if not leads:
        return []
    contacts = {c["id"]: c for c in _q("SELECT id::text AS id, name, phone, list_id::text AS list_id FROM public.contacts "
                                      "WHERE id = ANY(%s::uuid[])", ([l["contact_id"] for l in leads if l.get("contact_id")],))}
    out = []
    for lead in leads:
        if len(out) >= need:
            break
        if lead["id"] in skip:
            continue
        contact = contacts.get(lead.get("contact_id"))
        if not row.get("retry_enabled"):
            # Retrying is off: a redial still waiting is a future attempt that will not happen.
            call_retry.settle(lead, call_retry.NOT_RETRIED)
            res.redials["cancelled"] += 1
        elif not contact or not (contact.get("phone") or "").strip() or contact.get("list_id") != row.get("list_id"):
            # The number must still be in the campaign's list with a phone, or there is nobody to call.
            call_retry.settle(lead, call_retry.NOT_RETRIED)
            res.redials["cancelled"] += 1
        elif lead["attempts"] >= int(row.get("retry_max_attempts") or 1):
            # The maximum in force NOW: lowering it settles numbers that already have that many calls.
            call_retry.settle(lead, call_retry.MAX_ATTEMPTS)
            res.redials["max_attempts"] += 1
        else:
            out.append({"kind": "redial", "lead": lead, "contact": contact, "key": call_retry.phone_key(contact["phone"]),
                        "final": True})
    return out


def _pick_fresh(row: dict, need: int, taken_keys: set) -> dict:
    """Tier 1: the next `need` placeable numbers of the pass in seq order. Returns {"placeable", "consumed",
    "exhausted"}: `consumed` is every number looked at (duplicates included, they are skipped), `exhausted` that the
    list has nothing more after them. A number that repeats earlier in the batch, or that the campaign already tried
    in this pass, is a duplicate."""
    cid = row["id"]
    after = row.get("dial_seq")
    probe = dict(row)
    seen = set(taken_keys)
    placeable, consumed = [], []
    exhausted = False
    limit = need * 2 + 5
    for _ in range(FETCH_ROUNDS):
        probe["dial_seq"] = after
        rows = _fresh_sql(probe, "id::text AS id, name, phone, seq", "ORDER BY seq", limit)
        if not rows:
            exhausted = True
            break
        keys = [call_retry.phone_key(r.get("phone")) for r in rows]
        items = split_fresh(rows, _pass_keys(cid, row.get("dial_pass_started_at"), keys), seen)
        used = 0
        for it in items:
            if len(placeable) >= need:
                break
            used += 1
            consumed.append(it)
            if not it["dup"]:
                placeable.append(it)
        if len(placeable) >= need:
            exhausted = used == len(rows) and len(rows) < limit
            break
        if len(rows) < limit:
            exhausted = True
            break
        after = rows[-1]["seq"]
    return {"placeable": placeable, "consumed": consumed, "exhausted": exhausted}


# ── setup, stalls, notifications ──

def _notify(owner_id: str, title: str, body: str) -> None:
    """Best-effort in-app notification; it must never affect the campaign."""
    from routers.billing import _insert_notification

    _insert_notification(owner_id, "campaign_stalled", title, body)


def _setup(row: dict, owner_id: str) -> tuple:
    """(assistant id, phone id, stall reason or None, text) for placing calls: the same things Start checks, minus the
    hours. Reasons: agent, number, blocked (the account may not place calls), balance (empty)."""
    from routers import telephony

    assistant = None
    if row.get("agent_id"):
        a = supabase.table("ai_agents").select("vapi_assistant_id").eq("id", row["agent_id"]).maybe_single().execute().data
        assistant = (a or {}).get("vapi_assistant_id")
    if not assistant:
        return None, None, "agent", "its agent is not set up for calls"
    phone = None
    if row.get("phone_number_id"):
        p = supabase.table("phone_numbers").select("vapi_phone_id").eq("id", row["phone_number_id"]).maybe_single().execute().data
        phone = (p or {}).get("vapi_phone_id")
    if not phone:
        return assistant, None, "number", "its phone number is not active yet"
    blocked = telephony.outbound_call_block_reason(telephony.get_or_create_billing(owner_id))
    if blocked:
        return assistant, phone, "blocked", blocked
    if not telephony.check_call_quota(owner_id, "outbound"):
        return assistant, phone, "balance", "the balance is empty"
    return assistant, phone, None, None


def _stall(row: dict, token: str, list_id, reason: str, until: datetime, text: str | None = None,
           counters: dict | None = None, t: datetime | None = None) -> None:
    """The campaign cannot place calls now: record why, look again at `until`. The campaign stays Active and
    running and recovers by itself. The owner is told ONCE per episode (when the reason first appears) and not
    again for the same reason within NOTIFY_DEDUP_S, so a stall that flips on and off around its boundary does
    not send a notification each time (`counters` is the pass counters the time of the last one is kept in)."""
    t = t or _now()
    fields = {"dial_stall": reason, "dial_next_at": until}
    notify = row.get("dial_stall") != reason and reason in NOTIFY_STALLS
    if notify:
        counters = counters if counters is not None else dict(row.get("dial_counters") or {})
        told = counters.setdefault("notified", {})
        last = call_retry.parse_time(told.get(reason)) if isinstance(told, dict) else None
        if last is not None and 0 <= (t - last).total_seconds() < NOTIFY_DEDUP_S:
            notify = False
        else:
            if not isinstance(told, dict):
                told = counters["notified"] = {}
            told[reason] = _iso(t)
        fields["dial_counters"] = counters
    _save(row["id"], token, fields, list_id)
    if notify:
        name = row.get("name") or "Campaign"
        if reason == "balance":
            body = f"{name} is waiting: your balance cannot cover more calls right now. Add funds and it carries on by itself."
        elif reason == "provider_error":
            body = (f"{name} was paused: calls kept failing to start ({text or 'the calls could not be placed'}). "
                    "Check its agent and phone number, then press Start to carry on.")
        else:
            body = f"{name} is waiting: {text or 'it cannot place calls right now'}. It carries on by itself once that is fixed."
        _notify(row["user_id"], f"{name} cannot place calls right now" if reason != "provider_error" else f"{name} was paused", body)


def _learn_cap(open_after_release: int, t: datetime) -> None:
    """The provider refused a call for lack of capacity with `open_after_release` calls open: remember that as the
    platform's limit for a while (dial_limits reads it)."""
    try:
        _q("INSERT INTO public.platform_settings (id, dial_learned_cap, dial_learned_until) VALUES (1, %s, %s::timestamptz) "
           "ON CONFLICT (id) DO UPDATE SET dial_learned_cap = EXCLUDED.dial_learned_cap, "
           "dial_learned_until = EXCLUDED.dial_learned_until",
           (max(1, int(open_after_release)), _iso(t + timedelta(seconds=LEARNED_CAP_S))))
    except Exception:  # noqa: BLE001
        logger.warning("could not record the provider's call limit", exc_info=True)


# ── hours, finishing ──

def _finish_pass(campaign_id: str, token: str, list_id) -> bool:
    """The pass is over (every number handed out): the campaign stays Active, finished; its redials go on."""
    return _save(campaign_id, token, {
        "dial_running": False, "dial_seq": None, "dial_cursor": None, "dial_legacy_cursor": None,
        "dial_next_at": None, "dial_stall": None, "stopped_by_hours_at": None}, list_id)


def _handle_closed(row: dict, token: str, list_id, t: datetime, restore: dict | None, res: TickResult) -> None:
    """The calling hours are closed: no new call is placed in any strategy (calls in progress are never touched).
      running pass, something already handed out  park Paused, marked to continue by itself at the next opening
      running pass, nothing handed out yet        a Start restores the campaign as it was; otherwise it is parked
      running pass with nothing left to dial      the pass simply ends (nothing to continue)
      redial-only campaign                        the due redials move to the next opening, nothing is parked"""
    nxt = call_hours.next_opening(row, call_hours.CAMPAIGN, t)
    res.stopped = "hours"
    res.next_open_at = nxt
    cid = row["id"]
    if row.get("dial_running"):
        res.remaining = fresh_left(row)
        handed = row.get("dial_seq") is not None or bool(row.get("dial_cursor")) or bool(row.get("dial_legacy_cursor"))
        if not handed and restore is not None:
            _save(cid, token, {"status": restore.get("status") or "Inactive",
                               "stopped_by_hours_at": restore.get("stopped_by_hours_at"),
                               "dial_running": bool(restore.get("was_running")), "dial_next_at": None}, list_id)
            res.restored = True
        elif res.remaining == 0:
            _finish_pass(cid, token, list_id)
            res.finished = True
        else:
            _q("UPDATE public.outbound_campaigns SET status = 'Paused', stopped_by_hours_at = %s::timestamptz "
               "WHERE id = %s::uuid AND run_token = %s::uuid AND status = 'Active'", (_iso(t), cid, token))
            res.parked = True
    elif nxt:
        # Outside the hours a redial moves to the next allowed window instead of staying "due".
        moved = _q("UPDATE public.campaign_leads SET next_attempt_at = %s::timestamptz WHERE campaign_id = %s::uuid "
                   "AND final_status IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at <= %s::timestamptz RETURNING id",
                   (_iso(nxt), cid, _iso(t)))
        res.redials["waiting"] += len(moved)


# ── the tick ──

async def tick(campaign_id: str, now: datetime | None = None, *, fresh: bool = True, redials: bool = True,
               max_place: int | None = None, restore: dict | None = None) -> TickResult:
    """Serve one campaign once: claim it, place every call it has room for, release it. `fresh` / `redials` choose
    the queue tiers, `max_place` caps the calls placed (the dispatcher's budget; None = no cap beyond the
    campaign's own), `restore` (the inline tick of a Start: {status, stopped_by_hours_at, was_running}) is what the
    campaign goes back to when the hours close before its first call. `now` fixes the clock (tests); otherwise
    the clock is read again at every step. Never raises for dialing problems; a database error propagates."""
    res = TickResult()
    cid = str(campaign_id)
    if cid in _serving:
        res.claimed, res.skipped = False, "busy"
        return res
    _serving.add(cid)
    token = str(uuid.uuid4())
    claimed = False
    try:
        camp = _claim(cid, now or _now(), token)
        if not camp:
            res.claimed, res.skipped = False, "busy"
            return res
        claimed = True
        try:
            await asyncio.wait_for(_run(res, camp, token, now, fresh, redials, max_place, restore), TICK_TIMEOUT_S)
        except asyncio.TimeoutError:
            logger.warning("tick of campaign %s timed out after %s s", cid, TICK_TIMEOUT_S)
            res.stopped = "timeout"
    finally:
        if claimed:
            try:
                _release(cid, token)
            except Exception:  # noqa: BLE001
                logger.exception("could not release the claim on campaign %s", cid)
        _serving.discard(cid)
    if res.wake_at is not None:
        schedule_wake(res.wake_at, now)
    return res


async def _run(res: TickResult, camp0: dict, token: str, now_given, fresh: bool, redials: bool,
               max_place: int | None, restore: dict | None) -> None:
    """The body of a tick (see tick): loop until the campaign is at its limit, drained, closed, blocked, waiting, paused
    or the 15 s / 500-iteration budget is used up (then it nudges itself and hands over). Every database step runs
    in a worker thread (`io`), so a tick never holds the event loop for a round trip (a Concurrent group of 20 would
    otherwise be hundreds of blocking queries)."""
    from routers import telephony

    io = asyncio.to_thread
    cid, owner, list0 = camp0["id"], camp0["user_id"], camp0["list_id"]
    clock = lambda: now_given or _now()  # noqa: E731
    started = time.monotonic()
    iterations = 0
    memo: dict = {}                     # the wallet balance, read once per tick
    setup = None
    limits = None
    budget = max_place
    counters = dict(camp0.get("dial_counters") or {})
    last_row = camp0
    skip_leads: set = set()          # due redials this tick must not try again (they could not be screened)
    cleared_on_start = restore is None  # a Start / Resume (restore given) clears a stale stall once, in its first iteration

    while True:
        iterations += 1
        if iterations > TICK_MAX_ITERATIONS or time.monotonic() - started > TICK_BUDGET_S:
            res.stopped = "budget"
            nudge()
            break
        t = clock()
        row = await io(_read, cid, token)
        if not row or row["status"] != "Active" or row["list_id"] != list0:
            # A person paused / changed it (or deleted it, or a newer tick took the claim over): obeyed from here on.
            res.stopped = "paused"
            break
        last_row = row
        if not call_hours.is_open(row, call_hours.CAMPAIGN, t, if_unreadable=False):
            await io(_handle_closed, row, token, list0, t, restore, res)
            break
        if budget is not None and budget <= 0:
            res.stopped = "limit"
            break
        if not cleared_on_start:
            # Start / Resume: whatever stopped it before (a provider error, the screening, a full line) is looked at
            # afresh by this tick, so the live state does not keep saying "stalled" and the warning does not stay.
            cleared_on_start = True
            if row.get("dial_stall"):
                await io(_save, cid, token, {"dial_stall": None}, list0)
                row["dial_stall"] = None

        # Setup (agent, number, account): once per tick.
        if setup is None:
            setup = await io(_setup, row, owner)
        assistant, phone_id, stall, text = setup
        if stall:
            await io(_stall, row, token, list0, stall, t + timedelta(seconds=SETUP_RETRY_S), text, counters, t)
            res.stall, res.stopped = stall, "stalled"
            break
        if limits is None:
            limits = (await io(dial_limits.limits_for, [owner], t) or {}).get(owner) or {}
        counts = await io(_open_counts, owner, cid)

        # How many calls fit comes FIRST: a campaign that is at its limit places nothing, so it must not be stalled
        # (or notified, or held for 15 s) over a wallet it is not about to spend.
        s = dial_settings.describe(row)
        last_end = await io(_last_end, cid) if s["strategy"] == "sequential" and s["delay_seconds"] else None
        n, why, wake = capacity(row, counts, limits, t, last_end)
        if n <= 0:
            if why == "spacing" and wake and call_retry.parse_time(row.get("dial_next_at")) != wake:
                await io(_save, cid, token, {"dial_next_at": wake}, list0)     # a wake hint for the loop
            res.wake_at = wake if why == "spacing" else res.wake_at
            res.stopped = why or "capacity"
            break

        # Only a campaign that would place something needs the wallet to cover it.
        ok, balance, needed = await io(dial_limits.wallet_covers, owner, counts["owner"], t, memo)
        if not ok:
            await io(_stall, row, token, list0, "balance", t + timedelta(seconds=SETUP_RETRY_S), None, counters, t)
            res.stall, res.stopped = "balance", "stalled"
            break
        if row.get("dial_stall") in RECOVERED_STALLS:
            await io(_save, cid, token, {"dial_stall": None}, list0)      # recovered
            row["dial_stall"] = None
        if needed > 0:
            unit = needed / (counts["owner"] + 1)
            n = min(n, max(1, int((balance + 1e-9) // unit) - counts["owner"]))
        if budget is not None:
            n = min(n, budget)
        group = group_size(row, n, telephony.CAMPAIGN_BATCH_SIZE)

        # Pick: due redials first, then fresh numbers (only while a pass is open).
        items: list[dict] = []
        if redials:
            items += await io(_pick_redials, row, t, group, res, skip_leads)
        info = None
        if fresh and row.get("dial_running") and len(items) < group:
            info = await io(_pick_fresh, row, group - len(items), {it["key"] for it in items})
            items += info["placeable"]
        consumed = info["consumed"] if info else []
        if not items and not consumed:
            if info and info["exhausted"]:
                if await io(_finish_pass, cid, token, list0):
                    res.finished, res.stopped = True, "finished"
            else:
                res.stopped = res.stopped or "idle"
            break

        # Place the group (staggered), then settle what each placement did.
        results = await _place_group(row, items, token, list0, owner, assistant, phone_id, limits, now_given, clock, telephony)
        outcome = await io(_settle_results, row, t, items, results, consumed, counters, res, skip_leads)
        if budget is not None:
            budget -= outcome["placed"]

        # The group-end write: the place in the pass, the wait, the wave, the counters, the stall.
        fields = {"dial_counters": counters, "run_heartbeat_at": t}
        last = cursor_prefix(consumed)
        if last:
            fields["dial_seq"] = last["contact"]["seq"]
            fields["dial_cursor"] = last["contact"]["id"]
        prev_next = call_retry.parse_time(row.get("dial_next_at"))
        next_at = outcome["backoff_until"]
        if outcome["took"] and next_at is None:
            if s["strategy"] == "paced":
                next_at = paced_next(prev_next, t, dial_settings.spacing_seconds(row))
            elif s["strategy"] == "concurrent" and s["delay_seconds"] > 0:
                next_at = t + timedelta(seconds=s["delay_seconds"])
        if next_at is None and prev_next and prev_next > t:
            next_at = prev_next
        fields["dial_next_at"] = next_at
        fields["dial_stall"] = outcome["stall"]
        if outcome["took"]:
            fields["dial_batch_seq"] = int(row.get("dial_batch_seq") or 0) + 1
        if not await io(_save, cid, token, fields, list0):
            res.stopped = "paused"
            break
        if next_at is not None and next_at > t:
            res.wake_at = next_at          # the loop must wake for it (tick() schedules that), not sleep a whole interval past it
        if outcome["stall"]:
            res.stall = outcome["stall"]
        if outcome["breaker"]:
            await io(_save, cid, token, {"status": "Paused", "dial_stall": "provider_error", "stopped_by_hours_at": None}, list0)
            await io(_stall, {**row, "dial_stall": None}, token, list0, "provider_error", t, outcome["breaker"], counters, t)
            res.stall, res.stopped = "provider_error", "breaker"
            break
        # Every number handed out and the cursor reached the end: the pass is over.
        if info and info["exhausted"] and consumed and all(it.get("final") for it in consumed):
            if await io(_finish_pass, cid, token, list0):
                res.finished, res.stopped = True, "finished"
            break
        if next_at is not None and next_at > t:
            res.stopped = res.stopped or "spacing"
            break
        if outcome["stop"] == "stalled":
            res.stopped = "stalled"
            break
        # (a placement the gate refused for a Pause / the hours: the next iteration reads the row and acts on it)

    if res.suppressed:
        await io(telephony._notify_suppressed, owner, cid, camp0.get("name") or "Campaign", res.suppressed)
    if res.remaining is None and res.stopped == "paused" and last_row.get("dial_running"):
        try:
            res.remaining = await io(fresh_left, (await io(_read, cid, token)) or last_row)
        except Exception:  # noqa: BLE001
            res.remaining = None


async def _place_group(row, items, token, list0, owner, assistant, phone_id, limits, now_given, clock, telephony) -> list:
    """Place `items` together (call i starts i * dialer_burst_stagger_ms after the first), one result dict each."""
    if not items:
        return []
    cid = row["id"]
    cached: dict = {}
    keys: list = [None] * len(items)
    if row.get("dnc_screening_enabled", True):
        keys = [whitelist_service.normalize_phone(it["contact"]["phone"]) for it in items]
        cached = whitelist_service.cache_get_many(owner, [k for k in keys if k])
    stagger = max(0, int(settings.dialer_burst_stagger_ms)) / 1000.0

    def the_gate():
        return gate(cid, token, list0, clock(), limits)

    async def one(i: int, it: dict, key):
        if i and stagger:
            await asyncio.sleep(i * stagger)
        return await telephony._place_call(
            row, owner, it["contact"], assistant, phone_id, cached_verdict=cached.get(key),
            new_round=it["kind"] == "fresh", lead=it.get("lead"), gate=the_gate,
            dial={"source": "fresh" if it["kind"] == "fresh" else "redial"}, fail_closed=True, now=now_given)

    out = await asyncio.gather(*[one(i, it, k) for i, (it, k) in enumerate(zip(items, keys))], return_exceptions=True)
    results = []
    for it, r in zip(items, out):
        if isinstance(r, BaseException):
            if isinstance(r, asyncio.CancelledError):
                raise r
            logger.error("placing a call for campaign %s failed unexpectedly", cid, exc_info=r)
            r = {"success": False, "bookkeeping": True, "phone": (it["contact"] or {}).get("phone"), "error": str(r)}
        results.append(r)
    return results


def _settle_results(row: dict, t: datetime, items: list, results: list, consumed: list, counters: dict, res: TickResult,
                    skip: set) -> dict:
    """Fold the placement results of one group into the tick result, the pass counters and the cursor (`final`
    marks the fresh numbers whose turn is over). Returns what the group-end write needs: calls that took an attempt
    (`took`), calls placed (`placed`), a back-off, a stall, the breaker's text, a reason to stop the tick."""
    global _logged_capacity_body
    took = placed = 0
    backoff_until = None
    stall = None
    breaker = None
    stop = None
    capacity_hit = False

    def wait(seconds):
        nonlocal backoff_until
        until = t + timedelta(seconds=seconds)
        backoff_until = until if backoff_until is None or until > backoff_until else backoff_until

    counters.setdefault("fail_streak", 0)
    for it, r in zip(items, results):
        redial = it["kind"] == "redial"
        phone = r.get("phone") or (it["contact"] or {}).get("phone")
        it["final"] = True
        if r.get("took_attempt"):
            took += 1
        if r.get("success"):
            placed += 1
            counters["fail_streak"] = 0
            counters["backoff"] = 0
            if redial:
                res.redials_placed += 1
            else:
                res.placed += 1
        elif r.get("suppressed"):
            if redial:
                res.redials["suppressed"] += 1
            else:
                res.add_suppressed(phone, r.get("error"))
                counters["suppressed"] = counters.get("suppressed", 0) + 1
        elif r.get("busy"):
            if redial:
                res.redials["busy"] += 1
            else:
                res.already_on_call += 1
                counters["busy"] = counters.get("busy", 0) + 1
        elif r.get("gated"):
            it["final"] = False
            if r["gated"] == "capacity":
                wait(BACKOFF_S)
            else:
                stop = stop or r["gated"]       # paused / hours: the next iteration reads the row and acts on it
        elif r.get("unscreened"):
            it["final"] = False
            if redial:
                # It stays due; this tick does not try it again (it would spin on it), a later one does.
                res.redials["waiting"] += 1
                skip.add(it["lead"]["id"])
            if r.get("outage") or not redial:
                stall = "screening"
                wait(SCREENING_BACKOFF_S)
        elif r.get("slot_taken") or r.get("bookkeeping"):
            it["final"] = False
            wait(BACKOFF_S)
        elif r.get("capacity"):
            it["final"] = False
            capacity_hit = True
            if not _logged_capacity_body:
                _logged_capacity_body = True
                logger.warning("the provider refused a call for lack of capacity (logged once): %s", str(r.get("error"))[:500])
        elif r.get("daily_limit"):
            it["final"] = False
            stall = "number"
            wait(NUMBER_BACKOFF_S)
        else:
            # The provider could not place the call (that is a failed attempt), or the answer was lost (the attempt
            # stays open until the reaper closes it).
            if redial:
                res.redials["failed"] += 1
            else:
                res.add_error(phone, r.get("error"))
            counters["errors"] = counters.get("errors", 0) + 1
            counters["last_error"] = str(r.get("error") or "unknown")[:300]
            counters["last_error_at"] = _iso_out(t)
            if call_retry.placement_outcome(r.get("error")) != "invalid_number" and not r.get("ambiguous"):
                counters["fail_streak"] += 1
                if counters["fail_streak"] >= BREAKER_FAILS:
                    breaker = f"{counters['fail_streak']} calls in a row could not be placed, the last one: {counters['last_error']}"
    if capacity_hit:
        seconds = backoff_next(counters.get("backoff"))
        counters["backoff"] = seconds
        wait(seconds)
        stall = "provider_limit"
        _learn_cap(_open_counts(row["user_id"], row["id"])["platform"], t)
        stop = "stalled"
    dups = [it for it in consumed if it.get("dup")]
    if dups:
        res.duplicates += len(dups)
        res.already_on_call += len(dups)
        counters["duplicate"] = counters.get("duplicate", 0) + len(dups)
    return {"took": took, "placed": placed, "backoff_until": backoff_until, "stall": stall, "breaker": breaker, "stop": stop}


# ── the dispatcher ──

def _plan(t: datetime, campaign_id: str | None, fresh: bool) -> dict:
    """What to serve now: [(campaign row, calls it may place)] plus the earliest moment worth waking for. One candidate
    query, one grouped count of open calls, one read of the limits; campaigns of one account share its cap (the
    least recently served goes first and the budget shrinks as each is planned)."""
    from collections import defaultdict

    now_iso = _iso(t)
    cands = _q(
        "SELECT c.* FROM public.outbound_campaigns c WHERE c.status = 'Active' "
        "AND ((%(fresh)s AND c.dial_running) OR EXISTS (SELECT 1 FROM public.campaign_leads l WHERE l.campaign_id = c.id "
        "AND l.final_status IS NULL AND l.next_attempt_at IS NOT NULL AND l.next_attempt_at <= %(now)s::timestamptz)) "
        "AND (c.dial_next_at IS NULL OR c.dial_next_at <= %(now)s::timestamptz) "
        "AND (%(cid)s::uuid IS NULL OR c.id = %(cid)s::uuid)",
        {"fresh": bool(fresh), "now": now_iso, "cid": campaign_id})
    wake = None
    for r in _q("SELECT min(dial_next_at) AS w FROM public.outbound_campaigns WHERE status = 'Active' AND dial_next_at > %s::timestamptz",
                (now_iso,)):
        wake = call_retry.parse_time(r["w"])
    if not cands:
        return {"serve": [], "wake": wake}
    camp_open: dict = defaultdict(int)
    owner_open: dict = defaultdict(int)
    platform_open = 0
    for r in _q("SELECT campaign_id::text AS cid, user_id::text AS uid, count(*) AS n FROM public.campaign_attempts "
                "WHERE ended_at IS NULL GROUP BY 1, 2"):
        camp_open[r["cid"]] += int(r["n"])
        owner_open[r["uid"]] += int(r["n"])
        platform_open += int(r["n"])
    ids = [c["id"] for c in cands]
    last_placed = {r["cid"]: call_retry.parse_time(r["t"]) for r in _q(
        "SELECT campaign_id::text AS cid, max(placed_at) AS t FROM public.campaign_attempts "
        "WHERE campaign_id = ANY(%s::uuid[]) GROUP BY 1", (ids,))}
    delayed = [c["id"] for c in cands if dial_settings.describe(c)["strategy"] == "sequential"
               and dial_settings.describe(c)["delay_seconds"] > 0]
    last_end = {r["cid"]: r["t"] for r in _q(
        "SELECT campaign_id::text AS cid, max(ended_at) AS t FROM public.campaign_attempts "
        "WHERE campaign_id = ANY(%s::uuid[]) AND ended_at IS NOT NULL GROUP BY 1", (delayed,))} if delayed else {}
    limits = dial_limits.limits_for(list({c["user_id"] for c in cands}), t)
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    cands.sort(key=lambda c: last_placed.get(c["id"]) or epoch)
    serve = []
    for c in cands:
        uid = c["user_id"]
        if not call_hours.is_open(c, call_hours.CAMPAIGN, t, if_unreadable=False):
            serve.append((c, 0))        # closed: not skipped, its tick parks it (also when it is at capacity)
            continue
        n, why, w = capacity(c, {"campaign": camp_open[c["id"]], "owner": owner_open[uid], "platform": platform_open},
                             limits.get(uid), t, last_end.get(c["id"]))
        if n <= 0:
            if w and (wake is None or w > t and w < wake):
                wake = w
            continue
        serve.append((c, n))
        owner_open[uid] += n
        platform_open += n
    return {"serve": serve, "wake": wake}


async def dispatch_once(now: datetime | None = None, *, campaign_id: str | None = None, fresh: bool = True,
                        redials: bool = True, wait: bool = True) -> dict:
    """One dispatch: serve every campaign that has room to place a call. `campaign_id` limits it to one campaign
    (tests, Start), `fresh=False` serves redials only (the redial sweep). With wait=True the ticks are awaited and
    the result {"served", "results": {campaign id: TickResult}, "wake"} is complete; the background loop passes
    wait=False and the ticks go on in their own tasks."""
    global _last_dispatch
    t = now or _now()
    plan = await asyncio.to_thread(_plan, t, campaign_id, fresh)
    _last_dispatch = time.monotonic()
    out = {"served": len(plan["serve"]), "results": {}, "wake": plan["wake"]}

    async def one(c: dict, budget: int) -> None:
        try:
            out["results"][c["id"]] = await tick(c["id"], now, fresh=fresh, redials=redials, max_place=budget)
        except Exception:  # noqa: BLE001 - one campaign must not stop the others
            logger.exception("dialing campaign %s failed", c["id"])

    tasks = [asyncio.ensure_future(one(c, n)) for c, n in plan["serve"]]
    if wait:
        if tasks:
            await asyncio.gather(*tasks)
    else:
        for task in tasks:
            _tasks.add(task)
            task.add_done_callback(_tasks.discard)
    return out


async def dispatcher_loop() -> None:
    """Background task: dispatch whenever nudged, at the earliest `dial_next_at`, or every `dialer_tick_seconds`.
    Started from main._start_dialer unless the kill switch (DIALER_TICK_SECONDS=0) is on. A failing dispatch is
    logged and never stops the loop."""
    global _loop, _wake
    _loop = asyncio.get_running_loop()
    _wake = asyncio.Event()           # created here, inside the running loop, never at import
    interval = float(settings.dialer_tick_seconds)
    last_reap = 0.0
    while True:
        wake_in = None
        try:
            res = await dispatch_once(wait=False)
            if res.get("wake"):
                wake_in = max(0.05, (res["wake"] - _now()).total_seconds())
            if time.monotonic() - last_reap > 30:
                last_reap = time.monotonic()
                await asyncio.to_thread(call_retry.reap_unplaced, None, int(settings.dialer_unplaced_reap_seconds))
        except Exception:  # noqa: BLE001
            logger.exception("dispatch failed")
        try:
            await asyncio.wait_for(_wake.wait(), min(interval, wake_in) if wake_in else interval)
        except asyncio.TimeoutError:
            pass
        _wake.clear()


# ── the reconciler: the safety net under the end-of-call reports ──

_import_failures: dict = {}     # attempt id -> failed imports of its (provider-ended) call, since this process started
_last_lookup: dict = {}         # attempt id -> when it was last asked about by id (unlisted calls), so lookups rotate


def _record_complete(full: dict, t: datetime) -> bool:
    """True when the provider's record of an ended call is complete enough to bill from: its cost is there, or it
    ended at least RECONCILE_COST_WAIT_S ago (the cost is filled in a little after the end; importing before that
    would bill duration x rate and lock that figure in, because a call is charged only once)."""
    if full.get("cost") is not None:
        return True
    ended = call_retry.parse_time(full.get("endedAt"))
    return ended is None or (t - ended).total_seconds() >= RECONCILE_COST_WAIT_S


async def _reconcile_attempt(a: dict, listed: dict | None, t: datetime, out: dict) -> None:
    """Settle one open attempt whose call the provider reports as ended (or that it could not list): fetch the call, import
    it (which stores the conversation, bills once, closes the attempt and runs the post-call automations exactly once,
    see vapi_sync.import_and_automate). After RECONCILE_POISON_AFTER failed imports the attempt is closed directly so
    its slot is never held by one call that cannot be stored."""
    from services import vapi_sync

    call_id = a["vapi_call_id"]
    try:
        full = await vapi_client.get_call(call_id)
    except Exception as e:  # noqa: BLE001 - the provider could not be asked: the next cycle tries again
        out["errors"] += 1
        logger.warning("reconciler: could not fetch call %s: %s", call_id, e)
        return
    if not vapi_sync._is_ended(full):
        return                                          # still going
    if not _record_complete(full, t):
        out["waiting"] += 1                             # ended a moment ago, no cost in the record yet: next cycle
        return
    try:
        await vapi_sync.import_and_automate(full, a["user_id"], background=True)
        still_open = (await asyncio.to_thread(
            _q, "SELECT 1 FROM public.campaign_attempts WHERE id = %s::uuid AND ended_at IS NULL", (a["id"],)))
        if not still_open:
            _import_failures.pop(a["id"], None)
            out["settled"] += 1
            return
        raise RuntimeError("the call was stored but its attempt is still open")
    except Exception as e:  # noqa: BLE001
        n = _import_failures[a["id"]] = _import_failures.get(a["id"], 0) + 1
        out["errors"] += 1
        logger.warning("reconciler: importing call %s failed (%s of %s): %s", call_id, n, RECONCILE_POISON_AFTER, e)
        if n < RECONCILE_POISON_AFTER:
            return
    # Poison call: the provider says it ended but it cannot be imported. Close the attempt from the provider's record.
    outcome, reason = call_retry.outcome_from_record(full)
    closed = await asyncio.to_thread(call_retry.finish_attempt, a, outcome, reason,
                                     call_retry.parse_time(full.get("endedAt")) or t)
    _import_failures.pop(a["id"], None)
    if closed:
        out["poison"] += 1
        logger.warning("reconciler: call %s could not be imported after %s tries; its attempt was closed as %s",
                       call_id, RECONCILE_POISON_AFTER, outcome)


async def reconcile_once(now: datetime | None = None) -> dict:
    """One reconciliation of the open calls with the provider (the reconciler loop runs it every
    settings.dialer_reconcile_interval seconds; tests call it directly with a mocked vapi_client). The open attempts
    that have a call id and are older than RECONCILE_MIN_AGE_S cost ONE list request (limit = min(100, 2 * open + 20)).
    A call the list shows as ended is settled. A call missing from the list that was placed more than
    RECONCILE_UNLISTED_AFTER_S ago is asked about by id (at most RECONCILE_MAX_LOOKUPS per cycle). Returns counts:
    {"open", "settled", "poison", "errors", "lookups", "waiting"} ("waiting": ended calls whose cost is not in the
    provider's record yet, left for the next cycle). The ended calls are settled CONCURRENTLY (at most
    RECONCILE_CONCURRENCY at a time) and their post-call automations run in the background, so one slow call
    never holds the others (or the slots they free) back."""
    out = {"open": 0, "settled": 0, "poison": 0, "errors": 0, "lookups": 0, "waiting": 0}
    if not settings.vapi_api_key:
        return out
    t = now or _now()
    rows = await asyncio.to_thread(
        _q, "SELECT * FROM public.campaign_attempts WHERE ended_at IS NULL AND vapi_call_id IS NOT NULL "
            "AND placed_at <= %s::timestamptz ORDER BY placed_at", (_iso(t - timedelta(seconds=RECONCILE_MIN_AGE_S)),))
    out["open"] = len(rows)
    open_ids = {r["id"] for r in rows}
    for book in (_import_failures, _last_lookup):
        for stale in [k for k in book if k not in open_ids]:
            book.pop(stale, None)                       # its attempt is closed: forget what was kept about it
    if not rows:
        return out
    try:
        from services import vapi_sync
        calls = await vapi_client.list_calls(limit=min(100, 2 * len(rows) + 20))
    except Exception as e:  # noqa: BLE001
        out["errors"] += 1
        logger.warning("reconciler: could not list the provider's calls: %s", e)
        return out
    listed = {c.get("id"): c for c in calls or [] if c.get("id")}
    todo, unlisted = [], []
    for a in rows:
        c = listed.get(a["vapi_call_id"])
        if c is not None:
            if vapi_sync._is_ended(c):
                todo.append((a, c))
        elif (t - (call_retry.parse_time(a["placed_at"]) or t)).total_seconds() >= RECONCILE_UNLISTED_AFTER_S:
            looked = _last_lookup.get(a["id"])
            if looked is None or (t - looked).total_seconds() >= RECONCILE_LOOKUP_EVERY_S:
                unlisted.append(a)
    # Never looked up first, then the one looked up longest ago: a few stuck calls cannot starve the rest.
    unlisted.sort(key=lambda a: (_last_lookup.get(a["id"]) is not None, _last_lookup.get(a["id"]) or t, a["placed_at"]))
    for a in unlisted[:RECONCILE_MAX_LOOKUPS]:
        _last_lookup[a["id"]] = t
        todo.append((a, None))
    out["lookups"] = min(len(unlisted), RECONCILE_MAX_LOOKUPS)
    sem = asyncio.Semaphore(RECONCILE_CONCURRENCY)

    async def settle(a: dict, c) -> None:
        async with sem:
            await _reconcile_attempt(a, c, t, out)

    for (a, _), r in zip(todo, await asyncio.gather(*[settle(a, c) for a, c in todo], return_exceptions=True)):
        if isinstance(r, BaseException):
            out["errors"] += 1
            logger.error("reconciler: settling call %s failed unexpectedly", a.get("vapi_call_id"), exc_info=r)
    if out["settled"] or out["poison"] or out["errors"]:
        logger.info("reconciler: %s", out)
    return out


async def reconciler_loop() -> None:
    """Background task: reconcile the open calls with the provider every settings.dialer_reconcile_interval seconds
    (4 s, or 30 s when webhooks are configured). Started from main._start_dialer, so DIALER_TICK_SECONDS=0 turns it
    off too. A failing cycle is logged and never stops the loop."""
    interval = float(settings.dialer_reconcile_interval)
    if interval <= 0:
        return
    while True:
        try:
            await reconcile_once()
        except Exception:  # noqa: BLE001
            logger.exception("reconcile failed")
        await asyncio.sleep(interval)


def dispatcher_ok() -> bool:
    """True while the dispatcher loop is alive (it dispatched recently)."""
    if _loop is None or _last_dispatch is None:
        return False
    return time.monotonic() - _last_dispatch < max(15.0, 5 * float(settings.dialer_tick_seconds or 0))


def health(t: datetime | None = None) -> dict:
    """Operator view of the engine (GET /admin/dialer/health): when it last dispatched, the campaigns that are stalled
    (and why), the calls open for more than 10 minutes, and the capacity limit the provider last taught us."""
    t = t or _now()
    ago = None if _last_dispatch is None else round(time.monotonic() - _last_dispatch, 1)
    stalled = _q("SELECT id::text AS id, name, dial_stall AS reason FROM public.outbound_campaigns "
                 "WHERE status = 'Active' AND dial_stall IS NOT NULL ORDER BY name")
    old = int(_q("SELECT count(*) AS n FROM public.campaign_attempts WHERE ended_at IS NULL AND placed_at < %s::timestamptz",
                 (_iso(t - timedelta(minutes=10)),))[0]["n"])
    learned = None
    rows = _q("SELECT dial_learned_cap AS cap, dial_learned_until AS until FROM public.platform_settings WHERE id = 1")
    until = call_retry.parse_time(rows[0]["until"]) if rows else None
    if rows and rows[0]["cap"] and until and until > t:
        learned = {"cap": int(rows[0]["cap"]), "until": _iso_out(until)}
    return {"dispatcher_ok": dispatcher_ok(), "last_dispatch_seconds_ago": ago, "stalled_campaigns": stalled,
            "open_attempts_older_than_10_min": old, "learned_cap": learned,
            "loop_enabled": float(settings.dialer_tick_seconds) > 0}


# ── live view ──

def live_counts(row: dict, t: datetime | None = None) -> dict:
    """The live figures of one campaign: calls open now, numbers still queued (fresh and redials), redials due, calls
    placed in this pass and in the last minute."""
    t = t or _now()
    cid = row["id"]
    active = int(_q("SELECT count(*) AS n FROM public.campaign_attempts WHERE campaign_id = %s::uuid AND ended_at IS NULL", (cid,))[0]["n"])
    started = call_retry.parse_time(row.get("dial_pass_started_at"))
    placed = int(_q("SELECT count(*) AS n FROM public.campaign_attempts WHERE campaign_id = %s::uuid AND placed_at >= %s::timestamptz",
                    (cid, _iso(started)))[0]["n"]) if started else 0
    last_min = int(_q("SELECT count(*) AS n FROM public.campaign_attempts WHERE campaign_id = %s::uuid AND placed_at >= %s::timestamptz "
                      "AND placed_at <= %s::timestamptz", (cid, _iso(t - timedelta(seconds=60)), _iso(t)))[0]["n"])
    redial = _q("SELECT count(*) AS n, count(*) FILTER (WHERE next_attempt_at <= %s::timestamptz) AS due FROM public.campaign_leads "
                "WHERE campaign_id = %s::uuid AND final_status IS NULL AND next_attempt_at IS NOT NULL", (_iso(t), cid))[0]
    queued_fresh = fresh_left(row) if row.get("dial_running") else 0
    return {"active_now": active, "queued_fresh": queued_fresh, "queued_redials": int(redial["n"]),
            "redials_due_now": int(redial["due"]), "placed": placed, "placed_last_minute": last_min}


def live_state_name(row: dict, active_now: int, queued_redials: int, hours_open: bool) -> str:
    """dialing | finishing | waiting_hours | paused | stalled | waiting_redials | idle."""
    if row.get("status") != "Active":
        return "waiting_hours" if row.get("stopped_by_hours_at") and row.get("call_hours_enabled") else "paused"
    if row.get("dial_stall"):
        return "stalled"
    if row.get("dial_running"):
        return "dialing" if hours_open else "waiting_hours"
    if active_now > 0:
        return "finishing"
    if queued_redials > 0:
        return "waiting_redials" if hours_open else "waiting_hours"
    return "idle"


def live_state(row: dict, owner_limits: dict | None, t: datetime | None = None) -> dict:
    """The live payload of one campaign (GET /telephony/campaigns/live)."""
    t = t or _now()
    c = live_counts(row, t)
    cap, source = dial_limits.cap_of(owner_limits)
    hours_open = call_hours.is_open(row, call_hours.CAMPAIGN, t, if_unreadable=False)
    counters = row.get("dial_counters") or {}
    next_at = call_retry.parse_time(row.get("dial_next_at"))
    return {
        "campaign_id": row["id"],
        "state": live_state_name(row, c["active_now"], c["queued_redials"], hours_open),
        "strategy": dial_settings.describe(row)["strategy"],
        "settings": dial_settings.describe(row),
        "effective": dial_settings.effective(row, cap, source),
        "warnings": dial_limits.warnings_for(row, owner_limits),
        "active_now": c["active_now"],
        "queued": c["queued_fresh"] + c["queued_redials"],
        "queued_fresh": c["queued_fresh"],
        "queued_redials": c["queued_redials"],
        "redials_due_now": c["redials_due_now"],
        "placed": c["placed"],
        "placed_last_minute": c["placed_last_minute"],
        "counters": {"suppressed": int(counters.get("suppressed", 0)), "busy": int(counters.get("busy", 0)),
                     "duplicate": int(counters.get("duplicate", 0)), "errors": int(counters.get("errors", 0)),
                     "last_error": counters.get("last_error"), "last_error_at": counters.get("last_error_at")},
        "stall_reason": row.get("dial_stall"),
        "next_call_at": _iso_out(next_at) if next_at and next_at > t else None,
        "pass_started_at": _iso_out(row.get("dial_pass_started_at")),
        "dispatcher_ok": dispatcher_ok(),
        "as_of": t.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def live_states(owner_id: str, t: datetime | None = None) -> dict:
    """{campaign id: live payload} for the account's campaigns that are Active, running or have calls open."""
    t = t or _now()
    rows = _q("SELECT * FROM public.outbound_campaigns o WHERE o.user_id = %s::uuid AND (o.status = 'Active' OR o.dial_running "
              "OR EXISTS (SELECT 1 FROM public.campaign_attempts a WHERE a.campaign_id = o.id AND a.ended_at IS NULL))", (owner_id,))
    limits = (dial_limits.limits_for([owner_id], t) or {}).get(owner_id)
    return {r["id"]: live_state(r, limits, t) for r in rows}
