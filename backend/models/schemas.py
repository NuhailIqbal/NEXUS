"""
Pydantic request-body models shared by the FastAPI routers (imported as models.schemas),
plus the Envelope response shape.

Create* models describe POST bodies and Update* models describe PATCH bodies. FastAPI
validates incoming JSON against them and lists them on the generated /docs page. The Update*
models make every field Optional and the routers dump them with exclude_none=True, so an
omitted or null field is left unchanged (it cannot be cleared to NULL that way). Several
Create* models are inserted straight into a table via model_dump(), so their field names must
match the column names. The models hold shape and light validation only; ownership checks,
billing rules and calls to VAPI/Stripe/Twilio live in the routers and services.
"""
from pydantic import BaseModel, StrictBool, model_validator
from typing import Optional, Any, Literal


# ── Response envelope ──

class Envelope(BaseModel):
    """The `{data, error, meta}` response shape used across the API.

    Routers return this shape as plain dicts (e.g. `{"data": ..., "error": None}`, with `meta`
    for extras such as per-status counts on GET /callbacks); no router uses this model as a
    response_model, so it documents the convention rather than enforcing it.
    """
    data: object = None
    error: Optional[str] = None
    meta: Optional[dict] = None


# ── Profile ──

class ProfileUpdate(BaseModel):
    """Body for PATCH /profile: the caller's own editable profile fields."""
    full_name: Optional[str] = None
    company_name: Optional[str] = None
    phone: Optional[str] = None


# ── Contacts ──

class ContactCreate(BaseModel):
    """Body for POST /contacts.

    Inserted as-is into the `contacts` table (plus the owner's user_id). `status` is a
    free-text label, `list_id` optionally files the contact in a list, and `custom_data`
    holds arbitrary extra fields.
    """
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    status: str = "Active"
    list_id: Optional[str] = None
    custom_data: dict = {}


class ContactUpdate(BaseModel):
    """Body for PATCH /contacts/{id}: only the fields sent (non-null) are updated."""
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: Optional[str] = None
    list_id: Optional[str] = None
    custom_data: Optional[dict] = None


# ── Lists ──

class ListCreate(BaseModel):
    """Body for POST /lists: creates a named contact list for the caller's account."""
    name: str


class ListUpdate(BaseModel):
    """Body for PATCH /lists/{id}: renames a list."""
    name: Optional[str] = None


# ── Team ──

class TeamInvite(BaseModel):
    """Body for POST /team/invite (account owners only): who to invite and with which role."""
    member_email: str
    role: str = "member"  # "member" (can create/edit) | "viewer" (read-only)
    app_url: Optional[str] = None  # frontend origin, for building the invite-accept link


class TeamMemberUpdate(BaseModel):
    """Body for PATCH /team/{member_id} (owners only): change a member's role and/or status.

    The router limits `role` to 'member' or 'viewer'; `status` is only constrained by a
    database CHECK (Pending, Active or Removed).
    """
    role: Optional[str] = None
    status: Optional[str] = None


class TeamInviteAccept(BaseModel):
    """Body for POST /team/accept-invite (public, no auth).

    Redeems the one-time token from the invite email: the router creates the invitee's
    account with this password and enforces the minimum password length.
    """
    token: str
    password: str
    full_name: Optional[str] = None


# ── Integrations ──

class IntegrationCreate(BaseModel):
    """Body for POST /integrations.

    `config` carries the provider credentials/settings. The router encrypts it into the
    row's `config_encrypted` column and only ever returns a masked copy.
    """
    name: str
    description: Optional[str] = None
    status: str = "Active"
    category: str = "other"
    config: Optional[dict] = None


class IntegrationUpdate(BaseModel):
    """Body for PATCH /integrations/{id}.

    Only fields sent are changed; sending `config` replaces the whole stored config
    (it is re-encrypted), it is not merged with the old one.
    """
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    category: Optional[str] = None
    config: Optional[dict] = None


# ── AI Agents ──

class CallEventIn(BaseModel):
    """One event on an agent: either a library event by id, or (older form) by name."""
    # Id of an event in the account's event library (the normal form).
    event_id: Optional[str] = None
    # Older form, used when event_id is absent: the library event with this key (derived from
    # the label unless event_key is given) is reused, or created if it does not exist yet.
    label: Optional[str] = None
    event_key: Optional[str] = None
    # description, outcome, applies_to and schedules_callback only matter when the older form
    # creates a new library event; an existing library event keeps its own stored values.
    description: Optional[str] = None
    outcome: Optional[str] = None
    applies_to: Optional[Literal["both", "inbound", "outbound"]] = None
    # StrictBool: only a real JSON true/false is accepted, not "yes" or 1.
    schedules_callback: Optional[StrictBool] = None

    @model_validator(mode="after")
    def _needs_id_or_label(self):
        """Reject an entry with neither an event_id nor a non-blank label (returned as a 422)."""
        if not self.event_id and not (self.label or "").strip():
            raise ValueError("each call event needs an event_id or a label")
        return self


class CallEventCreate(BaseModel):
    """Body for POST /call-events: defines a new event in the account's event library."""
    # Display name; the event key is derived from it on the server.
    label: str
    # Shown to the AI agent in its prompt as the hint for when to raise the event (the label
    # is used when this is blank).
    description: Optional[str] = None
    # Outcome value this event gives the call: at hangup the last event raised on the call
    # sets conversations.call_outcome. Defaults to the label when blank.
    outcome: Optional[str] = None
    # Limits the event to inbound calls, outbound calls or both; matches the table's CHECK.
    applies_to: Literal["both", "inbound", "outbound"] = "both"
    # Marks an event that records a callback request (see the Callbacks models below).
    # StrictBool: only a real JSON true/false is accepted, not "yes" or 1.
    schedules_callback: StrictBool = False


class CallEventUpdate(BaseModel):
    """Body for PATCH /call-events/{id}: only the fields sent (non-null) are changed.

    Field meanings are the same as on CallEventCreate.
    """
    label: Optional[str] = None
    description: Optional[str] = None
    outcome: Optional[str] = None
    applies_to: Optional[Literal["both", "inbound", "outbound"]] = None
    schedules_callback: Optional[StrictBool] = None


# ── Callbacks ──

class CallbackSettingsUpdate(BaseModel):
    """Body for PATCH /callbacks/settings (account owner only).

    `auto_call` turns on automatic dialing of due callbacks (off by default; the calls are
    billed to the wallet). The other fields define the calling window and retry policy. Value
    ranges are validated in services/callback_service, not by this model.
    """
    # strict: the text "yes" must never switch on automatic calling by accident
    auto_call: Optional[StrictBool] = None
    # Zone in which the days, hours and default time below are read.
    timezone: Optional[str] = None
    # Days automatic callbacks may be placed: Monday = 0 ... Sunday = 6.
    work_days: Optional[list[int]] = None
    # "HH:MM" calling window; callbacks due outside it are moved to the next opening.
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    # "HH:MM" used as the due time when the caller did not give a usable one.
    default_time: Optional[str] = None
    # Delay before retrying a callback whose call could not be placed (service allows 5-1440).
    retry_minutes: Optional[int] = None
    # Attempts before a callback is marked failed (service allows 1-5).
    max_attempts: Optional[int] = None


class CallbackUpdate(BaseModel):
    """Body for PATCH /callbacks/{id}: change one callback in exactly one way.

    Send either `due_local` (reschedule) or `status` (manual override); the router rejects a
    body with both or neither.
    """
    # ISO date-time (e.g. 2026-05-01T17:00). A value without a zone is read in the account's
    # current timezone. Must be in the future; rescheduling resets the callback to pending.
    due_local: Optional[str] = None
    # Manual override: cancel the callback, or mark it as already handled by a person.
    status: Optional[Literal["cancelled", "called"]] = None


class AgentCreate(BaseModel):
    """Body for POST /agents (refused with 403 for deactivated, past-due or canceled accounts).

    The router stores the agent in `ai_agents` and, when VAPI is configured, creates the
    matching VAPI assistant plus its tools (preset tools, transfer, call events).
    """
    name: str
    # Voice name from the voice catalog (any casing); blank or unknown falls back to a
    # default for the language.
    voice: Optional[str] = None
    # UI language label or language code; drives the transcriber and the voice fallback.
    language: Optional[str] = "en"
    category: Optional[str] = None
    status: str = "Active"
    # The stored prompt is composed on the server from this (or a generic "You are <name>"
    # default) plus main_goal and knowledge_text.
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None
    main_goal: Optional[str] = None
    website: Optional[str] = None
    # Free-text reference knowledge: appended to the prompt and also saved as an
    # agent_knowledge row. Create-only; AgentUpdate has no equivalent.
    knowledge_text: Optional[str] = None
    # Keys of preset tools (e.g. send_email, send_sms) to provision in VAPI and attach.
    selected_tool_keys: Optional[list[str]] = None
    # E.164 number (e.g. +15551234567) the agent can transfer calls to; blank means no transfer.
    transfer_number: Optional[str] = None
    # Events the AI can raise mid-call, as library event ids (or the older label form).
    call_events: Optional[list[CallEventIn]] = None


class AgentTest(BaseModel):
    """Body for POST /agents/test: a quick text-only trial of a prompt in the Create-agent wizard.

    `message` is the sample caller message; the optional prompt and first message are the
    wizard's unsaved values to test with.
    """
    message: str
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


class AgentVoiceTestStart(BaseModel):
    """Body for POST /agents/test-voice/start.

    The wizard's unsaved form values, used to build a throwaway VAPI assistant for a live
    voice test before the agent is saved (nothing is written to `ai_agents`).
    """
    name: str
    voice: Optional[str] = None
    language: Optional[str] = None
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


class AgentAnalyzeWebsite(BaseModel):
    """Body for POST /agents/analyze-website (rate limited to 10/minute).

    The business website URL to fetch and summarize into a suggested main goal and industry.
    """
    url: str


class AgentUpdate(BaseModel):
    """Body for PATCH /agents/{id}: only the fields sent (non-null) are changed.

    Changes to the name, first message, prompt, language, tools, transfer number or events
    are also pushed to the agent's VAPI assistant when VAPI is configured.
    """
    name: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    # Stored exactly as sent: the UI edits the full final prompt, so it is not re-composed.
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None
    # Sent without system_prompt, the router appends the new goal to the stored prompt.
    main_goal: Optional[str] = None
    website: Optional[str] = None
    selected_tool_keys: Optional[list[str]] = None
    # E.164, validated in the router; an empty string removes the existing transfer tool.
    transfer_number: Optional[str] = None
    # The agent's complete event list: it replaces the current one, and [] clears it.
    call_events: Optional[list[CallEventIn]] = None


# ── Calendar ──

class CalendarSettingsUpdate(BaseModel):
    """Body for PATCH /calendar/settings (account owner only).

    Controls when the agent may book meetings on the connected Google Calendar. Values are
    validated in services/calendar_service (400 on bad input), not by this model.
    """
    # IANA zone name; common abbreviations such as EST or PST are mapped to a real region.
    timezone: Optional[str] = None
    # Bookable days: Monday = 0 ... Sunday = 6.
    work_days: Optional[list[int]] = None
    # "HH:MM" bookable hours on a working day.
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    # Meeting length in minutes (service allows 10-240).
    slot_minutes: Optional[int] = None
    # Padding kept free around existing events, in minutes (0-120).
    buffer_minutes: Optional[int] = None
    # The earliest bookable time is this many hours from now (0-168).
    min_notice_hours: Optional[int] = None
    # How far ahead a meeting may be booked, in days (1-90).
    max_days_ahead: Optional[int] = None


# ── Tools ──

class ToolCreate(BaseModel):
    """Body for POST /tools: a custom webhook tool an AI agent can call during a conversation.

    When VAPI is configured and `url` is set, the router also registers it as a VAPI
    function tool and stores the returned id.
    """
    name: str
    description: Optional[str] = None
    # Webhook the tool calls. Left empty, the tool is stored but not registered with VAPI.
    url: str = ""
    method: str = "POST"
    # Extra HTTP headers sent with the webhook request.
    headers: Optional[dict] = None
    # Arguments the AI fills in. Each dict has name, and optionally type, description,
    # enumValues, defaultValue and required; the router turns them into a JSON schema.
    parameters: Optional[list[dict]] = None


class ToolUpdate(BaseModel):
    """Body for PATCH /tools/{id}: only the fields sent (non-null) are changed.

    Changing any field except `status` also updates the linked VAPI tool, if there is one
    and VAPI is configured.
    """
    name: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    method: Optional[str] = None
    headers: Optional[dict] = None
    parameters: Optional[list[dict]] = None
    # Local state label only; a status-only change is not sent to VAPI.
    status: Optional[str] = None


# ── Campaigns ──

class CampaignCreate(BaseModel):
    """Body for POST /telephony/campaigns: an outbound calling campaign.

    Inserted as-is into `outbound_campaigns`. A campaign can be saved without a list or a
    number, but starting it requires both `list_id` and `phone_number_id`.
    """
    name: str
    # AI agent that places the calls.
    agent_id: Optional[str] = None
    # Contact list to dial.
    list_id: Optional[str] = None
    # phone_numbers.id to call from.
    phone_number_id: Optional[str] = None
    # Per-campaign opt-out of do-not-call screening; the account-wide WhitelistData
    # integration still decides whether screening is possible at all.
    dnc_screening_enabled: bool = True


class CampaignUpdate(BaseModel):
    """Body for PATCH /telephony/campaigns/{id}: only the fields sent (non-null) are changed."""
    name: Optional[str] = None
    agent_id: Optional[str] = None
    list_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    # Free-text state; the pause and resume endpoints set "Paused" and "Active".
    status: Optional[str] = None
    dnc_screening_enabled: Optional[bool] = None


# ── Inbound Queues ──

class InboundQueueCreate(BaseModel):
    """Body for POST /telephony/inbound: creates an AI Receptionist (inbound queue).

    The router returns 400 without `agent_id`, although the model allows None. With
    `phone_number_id` the agent is attached to that existing number; without it a new paid
    Twilio number is bought from the wallet, or the caller is sent to Stripe checkout when
    the balance is too low. `area_code` and `success_url` are not columns of the queue table
    and are dropped before the insert; they are only used on the Stripe checkout path.
    """
    name: str
    agent_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    area_code: Optional[str] = None
    # Queue settings stored on the row: how long a caller may wait, in seconds, and the
    # overflow behaviour (the table only accepts voicemail, hangup or transfer).
    max_wait_seconds: int = 120
    overflow_action: str = "voicemail"
    success_url: Optional[str] = None  # frontend app base for Stripe redirect (low-balance path)


class InboundQueueUpdate(BaseModel):
    """Body for PATCH /telephony/inbound/{id}: only the fields sent (non-null) are changed.

    Changing `agent_id` or `phone_number_id` also re-points the number's VAPI assistant when
    VAPI is configured.
    """
    name: Optional[str] = None
    agent_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    # The table only accepts "Active" or "Inactive".
    status: Optional[str] = None
    max_wait_seconds: Optional[int] = None
    overflow_action: Optional[str] = None


# ── Phone Numbers ──

class PhoneNumberCreate(BaseModel):
    """Body for POST /telephony/phone-numbers: provision a phone number for the account.

    Provider "vapi" gives a free VAPI number. Provider "twilio" is a paid number: it is
    bought from the wallet balance, or, when the balance is too low, the response asks the
    client to go through Stripe checkout and the number is provisioned after payment
    (POST /telephony/phone-numbers/confirm).
    """
    # number and area_code are optional hints for which number to provision.
    number: Optional[str] = None
    label: Optional[str] = None
    # Agent that answers inbound calls on the new number.
    agent_id: Optional[str] = None
    provider: str = "vapi"
    area_code: Optional[str] = None
    status: Optional[str] = "Active"
    success_url: Optional[str] = None  # frontend app base for Stripe redirect (low-balance path)


class PhoneNumberUpdate(BaseModel):
    """Body for PATCH /telephony/phone-numbers/{id}: assign or clear the answering agent, or change status.

    The router also points the number's VAPI assistant at the new agent when VAPI is configured
    and the number already has a VAPI id.
    """
    # An explicit null or empty value unassigns the agent: the router checks model_fields_set,
    # because exclude_none would otherwise silently drop it.
    agent_id: Optional[str] = None
    status: Optional[str] = None


# ── BYOT (Bring Your Own Twilio) ──

class TwilioCredentialCreate(BaseModel):
    """Body for POST /telephony/twilio-credentials: the user's own Twilio Account SID and Auth Token.

    The service verifies the pair with Twilio before saving. The token is stored encrypted
    and only a masked form is ever returned.
    """
    account_sid: str
    auth_token: str
    label: Optional[str] = None


class TwilioCredentialUpdate(BaseModel):
    """Body for PATCH /telephony/twilio-credentials/{id}: change the SID, token and/or label.

    Changing the SID or token re-validates with Twilio, reusing the stored value for
    whichever of the two is omitted; a label-only edit skips that check.
    """
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None
    label: Optional[str] = None


class PhoneNumberByotCreate(BaseModel):
    """Body for POST /telephony/phone-numbers/byot: add a number from one of the user's own Twilio accounts.

    There is no upfront charge or Stripe checkout; the reduced monthly hosting fee is billed
    by the recurring phone-billing sweep.
    """
    mode: str  # "import" | "purchase"
    # Id of a saved Twilio credential (see TwilioCredentialCreate) belonging to the caller.
    credential_id: str
    number: Optional[str] = None       # required for mode="import"
    area_code: Optional[str] = None    # optional, mode="purchase"
    agent_id: Optional[str] = None
    label: Optional[str] = None
    status: Optional[str] = "Active"


# ── Outbound Call ──

class OutboundCallCreate(BaseModel):
    """Body for POST /telephony/call: place one outbound call now with a chosen agent.

    Before dialing through VAPI the router checks the account status, the wallet balance and
    do-not-call screening.
    """
    # Destination number to dial.
    phone_number: str
    # ai_agents.id of the agent that conducts the call; it must already be set up in VAPI.
    agent_id: str
    # Optional phone_numbers.id to call from; ignored if that number has no VAPI id yet.
    phone_number_id: Optional[str] = None


# ── Voice Widgets ──

class VoiceWidgetCreate(BaseModel):
    """Body for POST /voice-widgets: an embeddable web voice-call button tied to an agent.

    Inserted as-is into `voice_widgets`.
    """
    name: str
    agent_id: Optional[str] = None
    # Only widgets with status "Active" are served by the public embed script.
    status: str = "Active"
    # Appearance settings: the embed script reads buttonLabel, buttonColor and position
    # (e.g. "bottom-right"), and also receives the whole object as CONFIG.
    config: dict = {}


class VoiceWidgetUpdate(BaseModel):
    """Body for PATCH /voice-widgets/{id}: only the fields sent (non-null) are changed.

    Sending `config` replaces the stored config object rather than merging into it.
    """
    name: Optional[str] = None
    agent_id: Optional[str] = None
    status: Optional[str] = None
    config: Optional[dict] = None
