from pydantic import BaseModel
from typing import Optional, Any


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


# ── Custom Fields ──

class CustomFieldCreate(BaseModel):
    name: str
    type: str = "Text"
    options: Optional[list] = None
    default_value: Optional[str] = None


class CustomFieldUpdate(BaseModel):
    name: Optional[str] = None
    type: Optional[str] = None
    options: Optional[list] = None
    default_value: Optional[str] = None


# ── Team ──

class TeamInvite(BaseModel):
    member_email: str
    role: str = "Viewer"


class TeamMemberUpdate(BaseModel):
    role: Optional[str] = None
    status: Optional[str] = None


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

class AgentCreate(BaseModel):
    name: str
    voice: Optional[str] = None
    language: Optional[str] = "en"
    category: Optional[str] = None
    status: str = "Active"
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None
    category: Optional[str] = None
    status: Optional[str] = None
    system_prompt: Optional[str] = None
    first_message: Optional[str] = None


# ── Tools ──

class ToolCreate(BaseModel):
    name: str
    description: Optional[str] = None
    url: str
    method: str = "POST"
    headers: Optional[dict] = None
    body_schema: Optional[dict] = None


class ToolUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    url: Optional[str] = None
    method: Optional[str] = None
    headers: Optional[dict] = None
    body_schema: Optional[dict] = None
    status: Optional[str] = None


# ── Campaigns ──

class CampaignCreate(BaseModel):
    name: str
    agent_id: Optional[str] = None
    list_id: Optional[str] = None
    phone_number_id: Optional[str] = None


class CampaignUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    list_id: Optional[str] = None
    phone_number_id: Optional[str] = None
    status: Optional[str] = None


# ── Inbound Queues ──

class InboundQueueCreate(BaseModel):
    name: str
    agent_id: Optional[str] = None
    max_wait_seconds: int = 120
    overflow_action: str = "voicemail"


class InboundQueueUpdate(BaseModel):
    name: Optional[str] = None
    agent_id: Optional[str] = None
    status: Optional[str] = None
    max_wait_seconds: Optional[int] = None
    overflow_action: Optional[str] = None


# ── Phone Numbers ──

class PhoneNumberCreate(BaseModel):
    number: Optional[str] = None
    agent_id: Optional[str] = None
    provider: str = "vapi"


class PhoneNumberUpdate(BaseModel):
    agent_id: Optional[str] = None
    status: Optional[str] = None


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
