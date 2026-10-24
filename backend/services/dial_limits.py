"""
How many campaign calls may be open at the same time, and what to tell the user when that is less than
they asked for.

Two caps apply to every placement (both count calls that are open right now):
  account   billing.max_concurrent_calls of the account, else platform_settings.dial_account_default.
            NULL on both = no cap. There is deliberately no built-in default: a default would silently
            break "about N calls per minute" for Paced campaigns.
  platform  min(platform_settings.dial_platform_max, dial_learned_cap while it has not expired).
            dial_learned_cap is what the provider last refused (see is_capacity_error); the dialer
            writes it and it expires by itself (dial_learned_until).

`limits_for` reads both and returns, per account:
  {"account_limit": int | None, "account_source": "account" | "default" | None,
   "platform_limit": int | None, "platform_source": "max" | "learned" | None}
`cap_of` folds that into the one lowest cap and whose it is ("account" | "platform"), which
dial_settings.effective and `warnings_for` use. Warning texts never name the provider.

Also here: the provider-rejection detector (`is_capacity_error`) and the wallet reserve check the dialer
makes before placing calls (`wallet_covers`).
"""
import logging
import re
from datetime import datetime, timezone

from config import settings
from database import supabase
from services import call_retry, dial_settings

logger = logging.getLogger(__name__)

MAX_CONCURRENT_CALLS = dial_settings.CONCURRENT_RANGE[1]
MAX_CALLS_PER_MINUTE = dial_settings.PER_MINUTE_RANGE[1]
MAX_DELAY_SECONDS = dial_settings.DELAY_RANGE[1]


def _cap(value) -> int | None:
    """A stored cap as a positive int, or None (no cap) for NULL / zero / garbage."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n >= 1 else None


def limits_for(owner_ids: list[str], now: datetime | None = None) -> dict[str, dict]:
    """{owner_id: limits} for each account (see the module docstring for the shape). One query for the
    billing rows and one for the platform row, whatever the number of accounts. Never raises: when a row
    cannot be read the account simply has no cap from it (a cap that cannot be read must not stop calls)."""
    now = now or datetime.now(timezone.utc)
    platform_default = platform_max = learned = None
    try:
        rows = supabase.table("platform_settings").select("*").limit(1).execute().data or []
        if rows:
            platform_default = _cap(rows[0].get("dial_account_default"))
            platform_max = _cap(rows[0].get("dial_platform_max"))
            until = call_retry.parse_time(rows[0].get("dial_learned_until"))
            if until and until > now:
                learned = _cap(rows[0].get("dial_learned_cap"))
    except Exception:  # noqa: BLE001
        logger.warning("could not read the platform dialing limits", exc_info=True)
    own: dict[str, int | None] = {}
    ids = [o for o in dict.fromkeys(owner_ids or []) if o]
    if ids:
        try:
            for r in supabase.table("billing").select("user_id, max_concurrent_calls").in_("user_id", ids).execute().data or []:
                own[r["user_id"]] = _cap(r.get("max_concurrent_calls"))
        except Exception:  # noqa: BLE001
            logger.warning("could not read the account dialing limits", exc_info=True)
    platform_limit, platform_source = None, None
    if platform_max is not None and (learned is None or platform_max <= learned):
        platform_limit, platform_source = platform_max, "max"
    elif learned is not None:
        platform_limit, platform_source = learned, "learned"
    out = {}
    for oid in ids:
        if own.get(oid) is not None:
            account_limit, account_source = own[oid], "account"
        elif platform_default is not None:
            account_limit, account_source = platform_default, "default"
        else:
            account_limit, account_source = None, None
        out[oid] = {"account_limit": account_limit, "account_source": account_source,
                    "platform_limit": platform_limit, "platform_source": platform_source}
    return out


def cap_of(limits: dict | None) -> tuple[int | None, str | None]:
    """(the lowest cap, whose it is) for one account's `limits`: (None, None) when there is none. A tie goes
    to the account, because that is the number the user can see and change."""
    limits = limits or {}
    a, p = limits.get("account_limit"), limits.get("platform_limit")
    if a is None and p is None:
        return None, None
    if p is None or (a is not None and a <= p):
        return a, "account"
    return p, "platform"


# ── what the provider's rejection of a call means ──

# A rejection because too many calls are in progress. Never the bare word "limit": a daily or spending
# limit says nothing about how many calls may run at once.
_CAPACITY_TEXT = re.compile(r"concurren|too many calls", re.I)
_DAILY_TEXT = re.compile(r"daily\W+(outbound\W+)?(call\W+)?limit|per[- ]day\W+limit|calls?\W+per\W+day", re.I)


def _error_text(e) -> str:
    body = getattr(e, "body", None)
    return f"{e} {body or ''}"


def is_daily_limit_error(e) -> bool:
    """True when the provider refused the call because the NUMBER reached its daily call limit (not a
    shortage of capacity: the dialer reports it as a problem with the number)."""
    return bool(_DAILY_TEXT.search(_error_text(e)))


def is_capacity_error(e) -> bool:
    """True when `e` (an exception from vapi_client.create_call, or an error text) says the provider has no room
    for another call right now: HTTP 429, or a message about concurrency / too many calls. A daily limit is
    NOT a capacity error; neither is any other mention of the word "limit"."""
    if is_daily_limit_error(e):
        return False
    status = getattr(e, "status_code", None)
    if status == 429:
        return True
    return bool(_CAPACITY_TEXT.search(_error_text(e)))


# ── warnings ──

def warnings_for(row: dict | None, limits: dict | None) -> list[str]:
    """What to tell the user when a cap makes the campaign do less than its settings ask. `row` is the campaign
    (or its settings); `limits` one account's limits from `limits_for`. Empty when nothing is capped."""
    cap, source = cap_of(limits)
    if cap is None:
        return []
    eff = dial_settings.effective(row, cap, source)
    if not eff["capped"]:
        return []
    s = dial_settings.describe(row)
    who = "your account allows" if source == "account" else "the platform currently allows"
    at_once = f"{cap} call{'s' if cap != 1 else ''} at the same time"
    if s["strategy"] == "concurrent":
        return [f"Concurrent Calls is set to {s['concurrent_calls']}, but {who} {at_once}. "
                f"Calls will run {cap} at a time."]
    who = who[0].upper() + who[1:]
    return [f"{who} {at_once}, so this campaign may place fewer than {s['calls_per_minute']} calls per minute."]


# ── wallet reserve ──

_balance_cache: dict[str, tuple[datetime, float, float]] = {}
BALANCE_CACHE_SECONDS = 15


def wallet_covers(owner_id: str, owner_open: int, now: datetime | None = None, memo: dict | None = None) -> tuple[bool, float, float]:
    """(enough, balance, needed): whether the account's wallet can carry one more call on top of the
    `owner_open` calls already open. Each call reserves `dial_reserve_minutes` of cost, so
    needed = (owner_open + 1) * per-minute rate * dial_reserve_minutes. The balance is read live (the sum of
    the active credit grants) and kept 15 seconds per account; `memo` (a dict the caller keeps for one
    tick) pins the figure for the whole tick. A balance that cannot be read counts as enough: the
    per-call quota check at Start still applies, and a read failure must not stop a campaign."""
    from routers import billing  # lazy: routers.billing imports a lot, and this module is imported by it

    now = now or datetime.now(timezone.utc)
    try:
        if memo is not None and owner_id in memo:
            balance, rate = memo[owner_id]
        else:
            cached = _balance_cache.get(owner_id)
            if cached and (now - cached[0]).total_seconds() < BALANCE_CACHE_SECONDS and now >= cached[0]:
                balance, rate = cached[1], cached[2]
            else:
                balance = float(billing.get_balance(owner_id))
                rate = float(billing.get_or_create_billing(owner_id).get("rate_per_minute") or billing.DEFAULT_RATE_PER_MINUTE)
                _balance_cache[owner_id] = (now, balance, rate)
            if memo is not None:
                memo[owner_id] = (balance, rate)
    except Exception:  # noqa: BLE001
        logger.warning("could not read the wallet balance of %s for the dialer", owner_id, exc_info=True)
        return True, 0.0, 0.0
    needed = round((max(0, int(owner_open)) + 1) * rate * float(settings.dial_reserve_minutes), 4)
    return balance >= needed, balance, needed


def forget_balance(owner_id: str | None = None) -> None:
    """Drop the cached wallet balance of one account (or all): after a top-up the campaign recovers at once."""
    if owner_id is None:
        _balance_cache.clear()
    else:
        _balance_cache.pop(owner_id, None)
