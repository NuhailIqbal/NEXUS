"""WhitelistData DNC / litigation suppression screening.

An OPTIONAL, per-user integration: each user supplies their own WhitelistData credentials
under Integrations. When configured and Active, every outbound number is screened before
dialing; a number the provider reports as "found" (on the DNC or litigator list) is not called.

Two rules that matter more than anything else here:

1. NOT CONFIGURED IS NOT THE SAME AS FAILED. A user who never set this up must be able to
   dial exactly as before — `check_number` returns allowed=True with source="disabled".
2. When the integration IS active, a failed check FAILS CLOSED (allowed=False). A timeout or
   provider outage must never be read as "safe to dial" — a wrong call here is a TCPA
   exposure, not a cosmetic bug.

Results are cached per user in `dnc_check_cache` for CACHE_TTL_DAYS, which also gives an
audit trail of what was screened when.
"""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

import httpx

from database import supabase
from services.encryption import decrypt_config

logger = logging.getLogger(__name__)

BASE_URL = "https://hooks.whitelistdata.com/api/DNCAndLitigationSuppression"

PROVIDER_KEY = "whitelistdata"
DEFAULT_SUPPRESSION_TYPE = "DNCAndLitigation"
CACHE_TTL_DAYS = 30
REQUEST_TIMEOUT = 10.0

# The provider is a third-party dependency in the hot path of dialing. Cap how hard we hit
# it: the campaign loop fires CAMPAIGN_BATCH_SIZE (20) dials concurrently, and because we
# fail closed, a self-inflicted 429 storm would block legitimate calls.
_MAX_CONCURRENT_LOOKUPS = 5
_semaphore = asyncio.Semaphore(_MAX_CONCURRENT_LOOKUPS)

# The exact response shape isn't documented; log the first body we see per process so it can
# be confirmed and the parser tightened.
_logged_sample = False


def normalize_phone(raw: str | None) -> str | None:
    """Digits-only canonical form, used both as the provider's phoneNumber and the cache key.

    Stored contact numbers are free-form text (`+1 (555) 123-4567`, `555-123-4567`, …), so
    they must be normalized or the same person would be screened — and cached — repeatedly
    under different spellings. A leading US country code is dropped so both spellings of a
    US number collapse to one key.
    """
    digits = "".join(ch for ch in (raw or "") if ch.isdigit())
    if not digits:
        return None
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


async def _get_whitelist_config(user_id: str) -> dict | None:
    """The user's active WhitelistData credentials, or None if not set up.

    Identified by a `provider` marker written into the encrypted config blob rather than by
    the row's display name: `category='other'` is a shared bucket (Zapier, HubSpot, OpenAI…),
    there is no provider column, and the name is free text the user can change.
    """
    # Nothing stops a user creating more than one WhitelistData row (there's no unique
    # constraint per provider), so pick deterministically: most recently updated wins.
    # Otherwise a stale row could silently outrank freshly corrected credentials and — under
    # fail-closed — block every call the user makes.
    result = (
        supabase.table("integrations")
        .select("config_encrypted, name")
        .eq("user_id", user_id)
        .eq("status", "Active")
        .order("updated_at", desc=True)
        .execute()
    )
    for row in (result.data or []):
        if not row.get("config_encrypted"):
            continue
        try:
            config = decrypt_config(row["config_encrypted"])
        except Exception:
            continue  # rotated encryption key or corrupt blob — skip, try the next row
        if config.get("provider") != PROVIDER_KEY:
            continue
        if config.get("apiKey"):
            return config
    return None


async def find_whitelist_integration(user_id: str) -> dict | None:
    """The user's WhitelistData integration row regardless of Active/Inactive status —
    `{"id": ..., "status": ...}`, or None if they've never configured one at all.

    Unlike `_get_whitelist_config`, this does NOT filter on status: it exists so a caller
    (the campaign wizard's on/off toggle) can find a currently-Inactive row and flip it back
    on via the normal PATCH /integrations/{id} endpoint, without duplicating the
    provider-detection logic that identifies "this row is a WhitelistData integration."
    """
    result = (
        supabase.table("integrations")
        .select("id, status, config_encrypted")
        .eq("user_id", user_id)
        .order("updated_at", desc=True)
        .execute()
    )
    for row in (result.data or []):
        if not row.get("config_encrypted"):
            continue
        try:
            config = decrypt_config(row["config_encrypted"])
        except Exception:
            continue
        if config.get("provider") != PROVIDER_KEY:
            continue
        if config.get("apiKey"):
            return {"id": row["id"], "status": row["status"]}
    return None


def _cache_get(user_id: str, phone_key: str) -> bool | None:
    """Cached suppression verdict, or None on miss/stale. Never raises."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CACHE_TTL_DAYS)).isoformat()
    try:
        res = (
            supabase.table("dnc_check_cache")
            .select("suppressed")
            .eq("user_id", user_id)
            .eq("phone_key", phone_key)
            .gt("checked_at", cutoff)
            .maybe_single()
            .execute()
        )
        if res.data:
            return bool(res.data.get("suppressed"))
    except Exception:
        logger.exception("DNC cache read failed for %s", phone_key)
    return None


def cache_get_many(user_id: str, phone_keys: list[str]) -> dict[str, bool]:
    """Fresh cached verdicts for a batch, so only misses hit the provider. Never raises."""
    if not phone_keys:
        return {}
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CACHE_TTL_DAYS)).isoformat()
    try:
        res = (
            supabase.table("dnc_check_cache")
            .select("phone_key, suppressed")
            .eq("user_id", user_id)
            .in_("phone_key", phone_keys)
            .gt("checked_at", cutoff)
            .execute()
        )
        return {r["phone_key"]: bool(r["suppressed"]) for r in (res.data or [])}
    except Exception:
        logger.exception("DNC cache batch read failed")
        return {}


def _cache_put(user_id: str, phone_key: str, suppressed: bool, raw: dict | None) -> None:
    """Record a verdict. Never raises — a cache write must not break a call decision."""
    try:
        supabase.table("dnc_check_cache").upsert(
            {
                "user_id": user_id,
                "phone_key": phone_key,
                "suppressed": suppressed,
                "raw_response": raw,
                "checked_at": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="user_id,phone_key",
        ).execute()
    except Exception:
        logger.exception("DNC cache write failed for %s", phone_key)


def _parse_found(body: str) -> bool | None:
    """Interpret the provider's response as "is this number on the list?".

    Tolerant on purpose: the documented sample uses `return_key=found` but the actual body
    shape isn't specified, so accept a bare boolean, a quoted/bare true/false string, or an
    object carrying a `found` key. Returns None if it can't be read — which the caller
    treats as a failed check (fail closed), never as "not found".
    """
    text = (body or "").strip().strip('"').strip().lower()
    if text in ("true", "1", "yes"):
        return True
    if text in ("false", "0", "no"):
        return False

    try:
        import json

        parsed = json.loads(body)
    except Exception:
        return None

    if isinstance(parsed, bool):
        return parsed
    if isinstance(parsed, dict):
        for key in ("found", "Found", "result", "value"):
            if key in parsed:
                val = parsed[key]
                if isinstance(val, bool):
                    return val
                if isinstance(val, str):
                    low = val.strip().lower()
                    if low in ("true", "1", "yes"):
                        return True
                    if low in ("false", "0", "no"):
                        return False
    return None


async def _lookup(config: dict, phone_key: str) -> tuple[bool | None, dict | None]:
    """One provider lookup. Returns (found, raw) — found=None means the check failed.

    Retries once on 429/5xx: because we fail closed, a transient rate-limit would otherwise
    block a call the user is entitled to make.
    """
    global _logged_sample
    params = {
        "code": config.get("code", ""),
        "secret": config.get("secret", ""),
        "phoneNumber": phone_key,
        "apiKey": config.get("apiKey", ""),
        "return_key": "found",
        "type": config.get("type") or DEFAULT_SUPPRESSION_TYPE,
    }

    for attempt in (1, 2):
        try:
            async with _semaphore:
                async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
                    r = await client.get(BASE_URL, params=params)

            if r.status_code == 429 or r.status_code >= 500:
                if attempt == 1:
                    await asyncio.sleep(1.0)
                    continue
                logger.warning(
                    "WhitelistData lookup failed after retry: %s %s", r.status_code, r.text[:200]
                )
                return None, None

            if r.status_code >= 400:
                logger.warning(
                    "WhitelistData rejected the request: %s %s", r.status_code, r.text[:200]
                )
                return None, None

            if not _logged_sample:
                logger.info("WhitelistData sample response body: %r", r.text[:300])
                _logged_sample = True

            found = _parse_found(r.text)
            if found is None:
                logger.warning("Could not parse WhitelistData response: %r", r.text[:200])
                return None, None
            return found, {"body": r.text[:500], "status": r.status_code}

        except Exception as e:
            if attempt == 1:
                await asyncio.sleep(1.0)
                continue
            logger.warning("WhitelistData lookup errored after retry: %s", e)
            return None, None

    return None, None


async def check_number(user_id: str, phone: str, *, cached: bool | None = None) -> dict:
    """Whether `phone` may be dialed for `user_id`.

    Returns {"allowed": bool, "reason": str | None, "source": "disabled"|"cache"|"api"}.

    Pass `cached` to reuse a verdict already fetched in a batch pre-warm and skip the
    per-number cache read.
    """
    config = await _get_whitelist_config(user_id)
    if not config:
        return {"allowed": True, "reason": None, "source": "disabled"}

    phone_key = normalize_phone(phone)
    if not phone_key:
        # Active integration, but nothing screenable — fail closed rather than dial blind.
        return {
            "allowed": False,
            "reason": "Number could not be read for DNC screening.",
            "source": "api",
        }

    if cached is None:
        cached = _cache_get(user_id, phone_key)
    if cached is not None:
        return {
            "allowed": not cached,
            "reason": "On your DNC/litigation suppression list." if cached else None,
            "source": "cache",
        }

    found, raw = await _lookup(config, phone_key)
    if found is None:
        return {
            "allowed": False,
            "reason": "DNC screening is unavailable, so the call was not placed.",
            "source": "api",
        }

    _cache_put(user_id, phone_key, found, raw)
    return {
        "allowed": not found,
        "reason": "On your DNC/litigation suppression list." if found else None,
        "source": "api",
    }
