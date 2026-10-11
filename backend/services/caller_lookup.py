"""Caller-number lookup for inbound caller verification.

Asks the line-type lookup endpoint (settings.caller_lookup_url) whether a caller's number is a
MOBILE line. Verification refuses a call exactly when the provider says it is not.

What the provider actually does (observed live; none of this is in its docs), because it is easy
to get wrong and a wrong guess here refuses real callers or lets every fake one through:

* `found` means "the line type equals the requested `type`", NOT "the number exists". The only
  accepted types are `mobile` and `landline`. With type=mobile a real landline or VoIP number
  (e.g. 650-253-0000) comes back `found:false`. With `debug=true` the body also carries the
  detected `lineType` (`mobile` / `landline` / `voip`); without it only `{"found": false}`.
* The phone number must be exactly 10 digits (a 12-digit foreign number is silently evaluated as
  its last 10 digits, so non-US numbers are never sent: see parse_caller_number).
* A number with no line type on record answers HTTP 502 with `found:false` and
  `error: "Line type not present in BLA response"` (an invalid number such as 000-000-0000, or one
  that is on a DNC list). That is the provider's verdict, so it is treated as "not mobile".
* Failures ALSO carry `found:false` in the body: a wrong api key is HTTP 400
  `{"found":false,"error":"Invalid Api Key"}`, a wrong `code` is an empty HTTP 401. Reading
  `found` without checking the HTTP status would refuse every caller the day a key is rotated,
  so only HTTP 200 (and the one 502 above, when the upstream reports success) count as verdicts.

A lookup that produces no verdict (timeout, network error, 4xx/5xx, unreadable body) is reported
as "unavailable"; the caller lets the call through rather than turn real customers away because a
third party is down. Credentials never appear in logs (see _RedactLookupSecrets).
"""
# Entry points: parse_caller_number (what to do with a raw caller id), lookup_mobile (one lookup,
# returns a LookupResult) and classify_response (pure; the unit-testable core of the parsing).
# Used by services/caller_verification.py. No database access.
import asyncio
import json
import logging
import re
import ssl
from dataclasses import dataclass

import certifi
import httpx

from config import settings

logger = logging.getLogger(__name__)

# Value of the provider's `type` parameter and of `lineType` in a positive answer.
LOOKUP_TYPE = "mobile"

# Body `error` the provider uses when it has no line type for a number; see module docstring.
_NO_LINE_TYPE_ERROR = "Line type not present in BLA response"


class _RedactLookupSecrets(logging.Filter):
    """Masks credentials in httpx's request log lines.

    The lookup API takes its credentials in the query string, and httpx logs every request URL,
    query included, at INFO level. Attached to the "httpx" logger below, so the keys cannot reach
    a log file whatever the deployment's log level is.
    """

    _PATTERN = re.compile(r"((?:code|secret|apiKey)=)[^&\s\"']+", re.IGNORECASE)

    def filter(self, record: logging.LogRecord) -> bool:
        """Rewrite the message and its arguments in place; never drops a record."""
        try:
            if isinstance(record.msg, str):
                record.msg = self._PATTERN.sub(r"\1***", record.msg)
            if isinstance(record.args, tuple):
                record.args = tuple(
                    self._PATTERN.sub(r"\1***", str(a)) if self._PATTERN.search(str(a)) else a
                    for a in record.args
                )
        except Exception:  # noqa: BLE001 — a logging filter must never break a request
            pass
        return True


logging.getLogger("httpx").addFilter(_RedactLookupSecrets())

# Overridden by tests with an httpx.MockTransport so the real request building is exercised.
_TRANSPORT: httpx.AsyncBaseTransport | None = None

# One TLS context for every lookup. A new httpx client otherwise loads the whole CA bundle again,
# synchronously, which was measured at 0.4-0.7 s of frozen event loop per call: with a few calls
# at once that pushed lookups past their deadline (callers answered unchecked) and past VAPI's.
_SSL_CONTEXT: ssl.SSLContext | None = None


def _ssl_context() -> ssl.SSLContext:
    """The shared TLS context (built on first use, then reused)."""
    global _SSL_CONTEXT
    if _SSL_CONTEXT is None:
        _SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
    return _SSL_CONTEXT


@dataclass(frozen=True)
class CallerNumber:
    """A caller id sorted by what can be done with it.

    kind: "us" (a 10-digit US/NANP number, in `national`), "invalid_us" (+1 with the wrong number
    of digits: not a real number), "foreign" (another country code: the provider cannot evaluate
    it), "other" (an extension, SIP address, short code…) or "none" (nothing to verify).
    """

    kind: str
    national: str | None = None


@dataclass(frozen=True)
class LookupResult:
    """Outcome of one lookup.

    outcome: "mobile" (found:true), "not_mobile" (the provider's verdict is found:false) or
    "unavailable" (no verdict could be obtained). line_type is the provider's `lineType` when it
    reported one; detail is a short secret-free code kept for the audit log ("found_false",
    "no_line_type", "timeout", "credentials_rejected", "http_503"…).
    """

    outcome: str
    line_type: str | None = None
    detail: str | None = None


def parse_caller_number(raw) -> CallerNumber:
    """Classify a caller id as VAPI reports it (E.164, e.g. "+15551234567").

    Only US numbers can be looked up. A "+1" number that does not have exactly 10 more digits is
    not a real number at all. Anything the provider cannot evaluate (another country, an
    extension, a SIP address, nothing at all) is NOT treated as fake: there is no verdict, so the
    caller lets the call through.
    """
    s = "" if raw is None else str(raw).strip()
    digits = re.sub(r"\D", "", s)
    if not digits:
        return CallerNumber("none")
    # Letters mean a SIP URI / name ("sip:1001@pbx", "anonymous"), not a dialable number.
    if re.search(r"[A-Za-z]", s):
        return CallerNumber("other")
    if s.startswith("+"):
        if digits.startswith("1"):
            national = digits[1:]
            return CallerNumber("us", national) if len(national) == 10 else CallerNumber("invalid_us")
        return CallerNumber("foreign")
    # No "+": a bare 10-digit US number, or 1 + 10 digits. Everything else (extensions such as
    # 1001, short codes, odd lengths) cannot be verified.
    if len(digits) == 10:
        return CallerNumber("us", digits)
    if len(digits) == 11 and digits.startswith("1"):
        return CallerNumber("us", digits[1:])
    return CallerNumber("other")


def _json_or_none(body: str):
    """The body parsed as JSON, or None when it is empty, not JSON, or nested too deeply to parse
    (RecursionError, e.g. a body of 200,000 "[")."""
    try:
        return json.loads(body)
    except (TypeError, ValueError, RecursionError):
        return None


def _clean_line_type(value) -> str | None:
    """The provider's lineType as a lower-case string, or None when absent or not a string."""
    if isinstance(value, str) and value.strip():
        return value.strip().lower()
    return None


def _is_no_line_type_verdict(data) -> bool:
    """True for the provider's "no line type on record" 502: a real answer about the number.

    It must say found:false with the known error text AND carry the upstream's own response
    (`raw`, itself a JSON string) reporting success. A 502 without that is an outage of the
    upstream service, which is not a verdict about the caller.
    """
    if not isinstance(data, dict) or data.get("found") is not False:
        return False
    if data.get("error") != _NO_LINE_TYPE_ERROR:
        return False
    raw = data.get("raw")
    if isinstance(raw, str):
        raw = _json_or_none(raw)
    return isinstance(raw, dict) and raw.get("status") == "success"


def classify_response(status: int, body: str) -> LookupResult:
    """Turn one HTTP response from the lookup endpoint into a LookupResult (pure, no I/O)."""
    data = _json_or_none(body)

    if status == 200:
        # `found` must be a real boolean; a missing or stringly-typed value is not trusted.
        if isinstance(data, dict) and isinstance(data.get("found"), bool):
            line_type = _clean_line_type(data.get("lineType"))
            if data["found"]:
                return LookupResult("mobile", line_type or LOOKUP_TYPE)
            return LookupResult("not_mobile", line_type, "found_false")
        return LookupResult("unavailable", detail="bad_response")

    if status == 502 and _is_no_line_type_verdict(data):
        return LookupResult("not_mobile", None, "no_line_type")

    # Everything below is a failure, not a verdict, even though most of these bodies say
    # found:false. A rejected key/code means verification is silently doing nothing, so say so
    # loudly (operators watch for it) without ever logging the credentials themselves.
    error_text = str(data.get("error", "")).lower() if isinstance(data, dict) else ""
    if status in (401, 403) or (status == 400 and "api key" in error_text):
        logger.error("Caller lookup credentials were rejected (HTTP %s); callers are NOT being verified", status)
        return LookupResult("unavailable", detail="credentials_rejected")
    if status == 429:
        return LookupResult("unavailable", detail="rate_limited")
    return LookupResult("unavailable", detail=f"http_{status}")


async def _fetch(national: str) -> tuple[int, str]:
    """One GET to the lookup endpoint for a 10-digit number: (HTTP status, body text)."""
    params = {
        "code": settings.caller_lookup_code,
        "phoneNumber": national,
        "type": LOOKUP_TYPE,
        # Adds `lineType` to the answer; the audit log records why a caller was refused.
        "debug": "true",
        "apiKey": settings.caller_lookup_api_key,
    }
    timeout = float(settings.caller_lookup_timeout_seconds)
    async with httpx.AsyncClient(timeout=timeout, transport=_TRANSPORT, verify=_ssl_context()) as client:
        r = await client.get(settings.caller_lookup_url, params=params)
    return r.status_code, r.text


def _discard_outcome(task: "asyncio.Future") -> None:
    """Done-callback for an abandoned lookup: mark its exception as seen so asyncio does not
    log "exception was never retrieved" for a request nobody is waiting on any more."""
    if not task.cancelled():
        task.exception()


async def lookup_mobile(national: str) -> LookupResult:
    """Look up one 10-digit US number. Never raises.

    VAPI allows the server about 7.5 s end-to-end to answer an inbound call, so the lookup gets
    caller_lookup_timeout_seconds and no more. The deadline is enforced with asyncio.wait and the
    abandoned request is cancelled WITHOUT being awaited: asyncio.wait_for waits for the
    cancelled request to finish tearing down its connection, which was measured to overrun a
    0.5 s budget by over half a second. A slow or failing provider yields "unavailable".
    """
    if not settings.caller_lookup_configured:
        return LookupResult("unavailable", detail="not_configured")
    budget = max(0.05, float(settings.caller_lookup_timeout_seconds))
    task = asyncio.ensure_future(_fetch(national))
    try:
        done, _ = await asyncio.wait({task}, timeout=budget)
    except asyncio.CancelledError:
        task.cancel()  # our own caller was cancelled: do not leave the request running
        raise
    if not done:
        task.cancel()
        task.add_done_callback(_discard_outcome)
        logger.warning("Caller lookup timed out after %.1fs", budget)
        return LookupResult("unavailable", detail="timeout")
    try:
        status, body = task.result()
    except httpx.TimeoutException:
        logger.warning("Caller lookup timed out (connection)")
        return LookupResult("unavailable", detail="timeout")
    except Exception as e:  # noqa: BLE001 — only the type is logged: messages can embed the URL
        logger.warning("Caller lookup request failed: %s", type(e).__name__)
        return LookupResult("unavailable", detail="network_error")
    try:
        return classify_response(status, body)
    except Exception as e:  # noqa: BLE001 — "never raises": an unreadable answer is no verdict
        logger.warning("Caller lookup answer could not be read: %s", type(e).__name__)
        return LookupResult("unavailable", detail="bad_response")
