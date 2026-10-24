"""
Dialing strategy settings of an outbound campaign: HOW the campaign places its calls.

Campaign settings (columns of `outbound_campaigns`)
  dial_strategy          sequential | concurrent | paced
  dial_concurrent_calls  Concurrent: calls kept in progress at the same time (1-20)
  dial_calls_per_minute  Paced: calls started per minute (1-60)
  dial_delay_seconds     gap between calls (0-60); what it measures depends on the strategy
                           Sequential  from the END of one call to the start of the next
                           Concurrent  between two call starts (the ramp up and every refill)
                           Paced       the slower of this and 60 / calls-per-minute wins

New campaigns are Sequential / 5 / 10 / 0; campaigns that existed before the feature were back-filled
to Concurrent / 20 by the migration (they always dialed in batches of up to 20 at once).

This module is pure: it validates and describes settings and works out what a cap does to them. The
caps themselves come from services/dial_limits.py; the engine that acts on all this is services/dialer.py.
Modelled on services/call_retry.py (validate / touched / settings_of).
"""
STRATEGIES = ("sequential", "concurrent", "paced")
STRATEGY_LABELS = {"sequential": "Sequential", "concurrent": "Concurrent", "paced": "Paced"}

FIELDS = ("dial_strategy", "dial_concurrent_calls", "dial_calls_per_minute", "dial_delay_seconds")
DEFAULTS = {
    "dial_strategy": "sequential",
    "dial_concurrent_calls": 5,
    "dial_calls_per_minute": 10,
    "dial_delay_seconds": 0,
}
CONCURRENT_RANGE = (1, 20)
PER_MINUTE_RANGE = (1, 60)
DELAY_RANGE = (0, 60)


class DialError(ValueError):
    """A dialing setting is invalid; the message is shown to the user."""


def touched(updates: dict) -> bool:
    """True when `updates` (a request body as a dict) sets any dialing field."""
    return any(k in updates for k in FIELDS)


def _int(value, message: str, low: int, high: int) -> int:
    # bool is an int in Python: True would otherwise pass as 1
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise DialError(message)
    return value


def validate(existing: dict | None, updates: dict) -> dict:
    """The dialing settings as they will be stored: `updates` merged over `existing` (then over the defaults),
    checked and normalised. All four fields are always returned. A field that is None in `updates` keeps its
    stored value. Raises DialError with a message for the user."""
    merged = {}
    for key in FIELDS:
        v = updates.get(key)
        if v is None:
            v = (existing or {}).get(key)
        merged[key] = DEFAULTS[key] if v is None else v
    strategy = merged["dial_strategy"]
    if not isinstance(strategy, str) or strategy.strip().lower() not in STRATEGIES:
        raise DialError("Dialing strategy must be Sequential, Concurrent or Paced.")
    merged["dial_strategy"] = strategy.strip().lower()
    _int(merged["dial_concurrent_calls"], "Concurrent calls must be a whole number from 1 to 20.", *CONCURRENT_RANGE)
    _int(merged["dial_calls_per_minute"], "Calls per minute must be a whole number from 1 to 60.", *PER_MINUTE_RANGE)
    _int(merged["dial_delay_seconds"], "Delay between calls must be a whole number of seconds from 0 to 60.", *DELAY_RANGE)
    return {k: merged[k] for k in FIELDS}


def describe(row: dict | None) -> dict:
    """The dialing settings of a campaign row as the short dict used in the API (`dialing.settings`) and
    stored on each attempt (`settings.dial`): {strategy, concurrent_calls, calls_per_minute, delay_seconds}.
    A missing or unreadable value (a row from before the feature, a bad edit) reads as its default, so this
    never raises."""
    row = row or {}
    out = {}
    for key, name in (("dial_strategy", "strategy"), ("dial_concurrent_calls", "concurrent_calls"),
                      ("dial_calls_per_minute", "calls_per_minute"), ("dial_delay_seconds", "delay_seconds")):
        v = row.get(key)
        out[name] = DEFAULTS[key] if v is None else v
    s = out["strategy"]
    out["strategy"] = s.strip().lower() if isinstance(s, str) and s.strip().lower() in STRATEGIES else DEFAULTS["dial_strategy"]
    for name, key, (low, high) in (("concurrent_calls", "dial_concurrent_calls", CONCURRENT_RANGE),
                                   ("calls_per_minute", "dial_calls_per_minute", PER_MINUTE_RANGE),
                                   ("delay_seconds", "dial_delay_seconds", DELAY_RANGE)):
        v = out[name]
        out[name] = v if isinstance(v, int) and not isinstance(v, bool) and low <= v <= high else DEFAULTS[key]
    return out


def _rate(per_minute: float):
    """A calls-per-minute figure for display: a whole number as an int, else one decimal."""
    r = round(per_minute, 1)
    return int(r) if r == int(r) else r


def effective(row: dict | None, cap: int | None = None, cap_source: str | None = None) -> dict:
    """What the campaign will really do once the account / platform cap on calls at the same time is applied:
      {"concurrent_calls": calls that can be open at once, "calls_per_minute": the rate that can be kept,
       "capped": bool, "cap": the cap or None, "cap_source": "account" | "platform" | None}
    `cap` is the lowest applicable cap (None = none), `cap_source` whose it is (see dial_limits.cap_of).

      Sequential  always 1 at a time (a cap is never lower than 1), so never capped.
      Concurrent  min(N, cap) at a time; capped when the cap is below N.
      Paced       no per-campaign limit, so concurrent_calls is the cap itself (or the safety limit); capped
                  when the cap is below the requested calls per minute, since a call lasts about a minute and
                  fewer calls than that can then be open at once (the real rate is a guess, hence "may").
    A delay that is longer than 60 / calls-per-minute lowers a Paced campaign's real rate to 60 / delay."""
    s = describe(row)
    strategy = s["strategy"]
    per_minute = s["calls_per_minute"]
    if strategy == "paced" and s["delay_seconds"] > 0:
        per_minute = min(per_minute, 60.0 / s["delay_seconds"])
    if strategy == "sequential":
        concurrent, capped = 1, False
    elif strategy == "concurrent":
        concurrent = s["concurrent_calls"] if cap is None else min(s["concurrent_calls"], cap)
        capped = cap is not None and cap < s["concurrent_calls"]
    else:
        from config import settings  # lazy: keeps this module importable without the app's settings
        safety = int(settings.dialer_paced_max_open)
        concurrent = safety if cap is None else min(safety, cap)
        capped = cap is not None and cap < s["calls_per_minute"]
    return {
        "concurrent_calls": concurrent,
        "calls_per_minute": _rate(per_minute) if strategy == "paced" else s["calls_per_minute"],
        "capped": bool(capped),
        "cap": cap,
        "cap_source": cap_source if cap is not None else None,
    }


def spacing_seconds(row: dict | None) -> float:
    """Paced: the seconds between two call starts, max(60 / calls-per-minute, delay). 6.0 for 10 per minute."""
    s = describe(row)
    return max(60.0 / s["calls_per_minute"], float(s["delay_seconds"]))


def label(row: dict | None) -> str:
    """"Concurrent" / "Sequential" / "Paced" for a campaign row (for messages)."""
    return STRATEGY_LABELS[describe(row)["strategy"]]

