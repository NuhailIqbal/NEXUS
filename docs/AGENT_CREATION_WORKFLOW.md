# AI Agent Creation — User Workflow

This document describes, step by step, how a user creates an AI voice agent in
EDM Nexus — the on-screen wizard flow and what happens behind the scenes.

---

## 1. Prerequisites

Before an agent can be created, the user must:

- **Be logged in** — a valid session token (`Authorization: Bearer <jwt>`) is required.
- **Have an active account** — deactivated accounts are blocked (`403`).
- **Be under their agent quota** — each plan has an `agents_limit` (Free = 10,
  Starter = 25, Growth = 50, Business = 100). Reaching the limit blocks creation
  with *"Agent limit reached. Upgrade your plan…"*.

---

## 2. Entry point

**Dashboard → AI Agents → “Create AI Agent”**
Route: `/dashboard/ai-agents/create`

The screen is a **5-step wizard** with a left-side progress tracker
(`Completed X/5`) and a **Back / Continue** footer. The final step's button
reads **“Create Agent”**.

---

## 3. The 5 wizard steps

### Step 1 — Complete Setup
Basic configuration and business context.

| Field | Required | Notes |
|---|---|---|
| **Agent Name** | ✅ | Display name of the agent |
| Website | ⬜ | Optional; has an “Analyze” helper button |
| **Main Goal** | ✅ | What the agent should accomplish |
| **Industry** | ✅ | Pick one of 8 (Retail, Healthcare, Finance, Real Estate, Education, Travel, SaaS, Other) → stored as `category` |
| Language | ⬜ | Default **English (US)** |
| Voice | ⬜ | Default **Aria** (Aria/Marco/Nora/Kai/Eva/Tom) |

*Validation:* Name, Main Goal, and Industry must be filled to continue.

### Step 2 — AI Tools
Select which actions the agent can perform during a call. Multi-select:

- **Send Email** — transactional emails
- **Book Calendar Slot** — schedule meetings
- **Update CRM** — sync contact updates
- **Send SMS** — via Twilio
- **Webhook Trigger** — POST a payload to a URL

*Validation:* at least one tool must be selected. Stored as `selected_tool_keys`.

### Step 3 — Knowledge Center
Give the agent information to answer accurately. Two options (one or both):

- **Quick Text** — pasted FAQs / policies / scripts, up to **8,000 characters**.
  Injected directly into the agent's instructions (available on every call).
- **Knowledge Files** — `.pdf, .txt, .md, .doc, .docx`, up to **10 MB each**.
  Retrieved on demand during the call.

*Validation:* at least one (text or file) is required; text over 8,000 chars must
be uploaded as a file instead.

### Step 4 — Prompt Studio
Define how the agent thinks and speaks.

| Field | Required | Maps to |
|---|---|---|
| **System Prompt** | ✅ | `system_prompt` |
| **Greeting Message** | ✅ | `first_message` (what the agent says first) |

### Step 5 — Testing
Send a sample message to sanity-check the agent before going live.

- **Test Message** (required) — a sample prompt.
- A mock response placeholder is shown (live testing happens after the agent goes live).

Clicking **Create Agent** submits everything.

---

## 4. What happens on “Create Agent” (behind the scenes)

Frontend calls `POST /agents` with the collected form data. The backend
(`backend/routers/agents.py → create_agent`) runs this sequence:

```
1. Billing check      → account active?           (else 403)
2. Quota check        → under agents_limit?        (else 403)
3. Compose prompt     → base prompt + main goal + knowledge text merged
                        into the final system prompt
4. Provision tools    → for each selected tool, ensure a matching VAPI tool
                        exists for the user (create if missing) → tool IDs
5. Create VAPI agent  → POST to VAPI /assistant with voice, language,
                        transcriber, model, first message, tool IDs
                        → returns vapi_assistant_id   (on failure → 502)
6. Save to Postgres   → INSERT into ai_agents (user_id, name, voice, language,
                        category, status, system_prompt, first_message,
                        main_goal, website, selected_tool_keys, vapi_assistant_id)
7. Save knowledge     → if quick-text provided, INSERT into agent_knowledge
```

Then, if any **knowledge files** were attached, the frontend uploads each one
via `POST /agents/{id}/knowledge` — the file is stored (local storage) and, if
VAPI is configured, uploaded to VAPI and recorded in `agent_knowledge`.

> **Important ordering:** the VAPI assistant is created **before** the database
> insert. If VAPI creation fails, the agent is **not** saved anywhere — so a
> failed creation leaves no partial record.

---

## 5. Where the agent lives

- **PostgreSQL** — the `ai_agents` row is the source of truth (owned by `user_id`).
- **VAPI** — the corresponding voice assistant, linked via `vapi_assistant_id`.
- **agent_knowledge** — any pasted text and uploaded documents.

---

## 6. Success

On success, a confetti **“Agent Created”** modal appears, then the user is
redirected to **AI Agents** (`/dashboard/ai-agents`) where the new agent is
listed and ready to be attached to phone numbers / campaigns.

---

## 7. Flow at a glance

```
Login ✔  →  AI Agents  →  Create AI Agent
   │
   ▼
Step 1 Setup ─ Step 2 Tools ─ Step 3 Knowledge ─ Step 4 Prompt ─ Step 5 Testing
   │                                                                     │
   │                                                          [Create Agent]
   ▼                                                                     ▼
                       POST /agents
   Billing ✔ → Quota ✔ → Compose prompt → Provision tools →
   Create VAPI assistant → Save to Postgres → Save knowledge
   (+ upload knowledge files → POST /agents/{id}/knowledge)
   │
   ▼
 “Agent Created” 🎉  →  redirect to AI Agents list
```
