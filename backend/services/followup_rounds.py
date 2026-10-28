"""
Follow-up rounds of an outbound campaign: after the list is complete, the numbers that never picked up (final
status "Max attempts reached", see services/call_retry.py) are called again by the campaign itself, up to a set number
of extra rounds, with a wait between the rounds. Off by default; the manual "Retry unreached numbers" button is a
separate, unlimited action that does not use up these rounds.

Campaign settings (columns of `outbound_campaigns`, set by the person)
  followup_rounds     extra rounds after the list is complete (0-3; 0 = off)
  followup_gap_hours  wait between the end of one round and the start of the next (1-48)

Engine state (written by the server only, never accepted from a client)
  followup_done       rounds already started (reset to 0 when Start begins a new pass)
  followup_next_at    when the next round is due; NULL = none scheduled

This module is pure (validation and descriptions). The engine that schedules and starts the rounds is
`run_followups` in services/campaign_scheduler.py; the numbers are put back in the queue by
`call_retry.requeue_unreached`, so the dialing strategy, the calling hours and the account caps apply to them as to
every other call. Modelled on services/call_retry.py and services/dial_settings.py (validate / touched).
"""
FIELDS = ("followup_rounds", "followup_gap_hours")
DEFAULTS = {"followup_rounds": 0, "followup_gap_hours": 24}
ROUNDS_RANGE = (0, 3)
GAP_RANGE = (1, 48)

# Follow-up rounds need Auto Redial: with it off, a number that never picks up is settled "Not retried", never
# "Max attempts reached", so there would be nothing for a round to call.
NEEDS_RETRY = "Follow-up rounds need Auto Redial to be on."


class FollowupError(ValueError):
    """A follow-up setting is invalid; the message is shown to the user."""


def touched(updates: dict) -> bool:
    """True when `updates` (a request body as a dict) sets any follow-up field."""
    return any(k in updates for k in FIELDS)


def _int(value, message: str, low: int, high: int) -> int:
    # bool is an int in Python: True would otherwise pass as 1
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise FollowupError(message)
    return value


def validate(existing: dict | None, updates: dict) -> dict:
    """The follow-up settings as they will be stored: `updates` merged over `existing` (then over the
    defaults), checked. Both fields are always returned. A field that is None in `updates` keeps its stored value.
    `retry_enabled` is read the same way (updates over existing), so turning Auto Redial off while rounds are still on
    is refused as well. Raises FollowupError with a message for the user."""
    merged = {}
    for key in FIELDS:
        v = updates.get(key)
        if v is None:
            v = (existing or {}).get(key)
        merged[key] = DEFAULTS[key] if v is None else v
    _int(merged["followup_rounds"], "Follow-up rounds must be a whole number from 0 to 3.", *ROUNDS_RANGE)
    _int(merged["followup_gap_hours"], "Wait between rounds must be a whole number of hours from 1 to 48.", *GAP_RANGE)
    retry = updates.get("retry_enabled")
    if retry is None:
        retry = (existing or {}).get("retry_enabled")
    if merged["followup_rounds"] > 0 and not retry:
        raise FollowupError(NEEDS_RETRY)
    return {k: merged[k] for k in FIELDS}


def describe(row: dict | None) -> dict:
    """The `followup` object of a campaign row as the API returns it: {rounds, gap_hours, done, next_at, waiting}.
    `waiting` is true while a round is scheduled. A missing or unreadable value (a row from before the feature)
    reads as off, so this never raises."""
    row = row or {}

    def whole(key, default, low, high):
        v = row.get(key)
        return v if isinstance(v, int) and not isinstance(v, bool) and low <= v <= high else default

    next_at = row.get("followup_next_at")
    return {
        "rounds": whole("followup_rounds", DEFAULTS["followup_rounds"], *ROUNDS_RANGE),
        "gap_hours": whole("followup_gap_hours", DEFAULTS["followup_gap_hours"], *GAP_RANGE),
        "done": whole("followup_done", 0, 0, 1_000_000),
        "next_at": next_at or None,
        "waiting": bool(next_at),
    }
