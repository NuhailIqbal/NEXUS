from pydantic import BaseModel, StrictBool, model_validator
from typing import Optional, Any, Literal


# ── Response envelope ──

class Envelope(BaseModel):
    data: object = None
    error: Optional[str] = None
    meta: Optional[dict] = None


# ── Profile ──

class ProfileUpdate(BaseModel):
    full_name: Optional[str] = None
    company_name: Optional[str] = None
    phone: Optional[str] = None


# ── Contacts ──

class ContactCreate(BaseModel):
    name: str
    phone: Optional[str] = None
    email: Optional[str] = None
    status: str = "Active"
    list_id: Optional[str] = None
    custom_data: dict = {}


class ContactUpdate(BaseModel):
    name: Optional[str] = None
    phone: Optional[str] = None
    email: Optional[str] = None
    status: Optional[str] = None
    list_id: Optional[str] = None
    custom_data: Optional[dict] = None


# ── Lists ──

class ListCreate(BaseModel):
    name: str


class ListUpdate(BaseModel):
    name: Optional[str] = None


# ── Team ──

class TeamInvite(BaseModel):
    member_email: str
    role: str = "member"  # "member" (can create/edit) | "viewer" (read-only)
    app_url: Optional[str] = None  # frontend origin, for building the invite-accept link


class TeamMemberUpdate(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None


class TeamInviteAccept(BaseModel):
    token: str
    password: str
    full_name: Optional[str] = None


# ── Integrations ──

class IntegrationCreate(BaseModel):
    name: str
    description: Optional[str] = None
    status: str = "Active"
    category: str = "other"
    config: Optional[dict] = None


class IntegrationUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None
    category: Optional[str] = None
    config: Optional[dict] = None


# ── AI Agents ──

class CallEventIn(BaseModel):
    """One event on an agent: either a library event by id, or (older form) by name."""
    event_id: Optional[str] = None
    label: Optional[str] = None
    event_key: Optional[str] = None
    description: Optional[str] = None
    outcome: Optional[str] = None
    applies_to: Optional[Literal["both", "inbound", "outbound"]] = None
    schedules_callback: Optional[StrictBool] = None

    @model_validator(mode="after")
    def _needs_id_or_label(self):
        if not self.event_id and not (self.label or "").strip():
            raise ValueError("each call event needs an event_id or a label")
        return self


class CallEventCreate(BaseModel):
    label: str
    description: Optional[str] = None
    outcome: Optional[str] = None
    applies_to: Literal["both", "inbound", "outbound"] = "both"
    schedules_callback: StrictBool = False


class CallEventUpdate(BaseModel):
    label: Optional[str] = None
    description: Optional[str] = None
    outcome: Optional[str] = None
    applies_to: Optional[Literal["both", "inbound", "outbound"]] = None
    schedules_callback: Optional[StrictBool] = None


# ── Callbacks ──

class CallbackSettingsUpdate(BaseModel):
    # strict: the text "yes" must never switch on automatic calling by accident
    auto_call: Optional[StrictBool] = None
    timezone: Optional[str] = None
    work_days: Optional[list[int]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    default_time: Optional[str] = None
    retry_minutes: Optional[int] = None
    max_attempts: Optional[int] = None


class CallbackUpdate(BaseModel):
    due_local: Optional[str] = None
    status: Optional[Literal["cancelled", "called"]] = None


class AgentCreate(BaseModel):
    name: str
    voice: Optional[str] = None
    language: Optional[str] = "en"
    category: Optional[str] = None
    status: str = "Active"
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None
    main_goal: Optional[str] = None
    website: Optional[str] = None
    knowledge_text: Optional[str] = None
    selected_tool_keys: Optional[list[str]] = None
    transfer_number: Optional[str] = None
    call_events: Optional[list[CallEventIn]] = None


class AgentTest(BaseModel):
    message: str
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


class AgentVoiceTestStart(BaseModel):
    name: str
    voice: Optional[str] = None
    language: Optional[str] = None
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


class AgentAnalyzeWebsite(BaseModel):
    url: str


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None
    main_goal: Optional[str] = None
    website: Optional[str] = None
    selected_tool_keys: Optional[list[str]] = None
    transfer_number: Optional[str] = None
    call_events: Optional[list[CallEventIn]] = None


# ── Calendar ──

class CalendarSettingsUpdate(BaseModel):
    timezone: Optional[str] = None
    work_days: Optional[list[int]] = None
    start_time: Optional[str] = None
    end_time: Optional[str] = None
    slot_minutes: Optional[int] = None
    buffer_minutes: Optional[int] = None
    min_notice_hours: Optional[int] = None
    max_days_ahead: Optional[int] = None


# ── Tools ──

class ToolCreate(BaseModel):
    name: str
    description: Optional[str] = None
    url: str = ""
    method: str = "POST"
    headers: Optional[dict] = None
    parameters: Optional[list[dict]] = None


class ToolUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    method: Optional[str] = None
    headers: Optional[dict] = None
    parameters: Optional[list[dict]] = None
    status: Optional[str] = None


# ── Campaigns ──

class CampaignCreate(BaseModel):
    name: str
    agent_id: Optional[str] = None
    list_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    dnc_screening_enabled: bool = True


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    list_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    status: Optional[str] = None
    dnc_screening_enabled: Optional[bool] = None


# ── Inbound Queues ──

class InboundQueueCreate(BaseModel):
    name: str
    agent_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    area_code: Optional[str] = None
    max_wait_seconds: int = 120
    overflow_action: str = "voicemail"
    success_url: Optional[str] = None  # frontend app base for Stripe redirect (low-balance path)


class InboundQueueUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    status: Optional[str] = None
    max_wait_seconds: Optional[int] = None
    overflow_action: Optional[str] = None


# ── Phone Numbers ──

class PhoneNumberCreate(BaseModel):
    number: Optional[str] = None
    label: Optional[str] = None
    agent_id: Optional[str] = None
    provider: str = "vapi"
    area_code: Optional[str] = None
    status: Optional[str] = "Active"
    success_url: Optional[str] = None  # frontend app base for Stripe redirect (low-balance path)


class PhoneNumberUpdate(BaseModel):
    agent_id: Optional[str] = None
    status: Optional[str] = None


# ── BYOT (Bring Your Own Twilio) ──

class TwilioCredentialCreate(BaseModel):
    account_sid: str
    auth_token: str
    label: Optional[str] = None


class TwilioCredentialUpdate(BaseModel):
    account_sid: Optional[str] = None
    auth_token: Optional[str] = None
    label: Optional[str] = None


class PhoneNumberByotCreate(BaseModel):
    mode: str  # "import" | "purchase"
    credential_id: str
    number: Optional[str] = None       # required for mode="import"
    area_code: Optional[str] = None    # optional, mode="purchase"
    agent_id: Optional[str] = None
    label: Optional[str] = None
    status: Optional[str] = "Active"


# ── Outbound Call ──

class OutboundCallCreate(BaseModel):
    phone_number: str
    agent_id: str
    phone_number_id: Optional[str] = None


# ── Voice Widgets ──

class VoiceWidgetCreate(BaseModel):
    name: str
    agent_id: Optional[str] = None
    status: str = "Active"
    config: dict = {}


class VoiceWidgetUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    status: Optional[str] = None
    config: Optional[dict] = None
