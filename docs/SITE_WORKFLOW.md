# EDM Nexus — Complete Site User Workflow

An end-to-end guide to how a user moves through the entire platform, from first
visit to running live AI calls and monitoring results. For the detailed agent
wizard, see [AGENT_CREATION_WORKFLOW.md](AGENT_CREATION_WORKFLOW.md).

---

## 0. The golden path (at a glance)

```
Visit site → Request Access / Register → Log in
      │
      ▼
Quick Setup (onboarding checklist)
      │
      ├─ 1. Create an AI Agent      (voice + prompt + tools + knowledge)
      ├─ 2. Get a Phone Number      (VAPI or auto-bought Twilio)
      ├─ 3. Add Contacts            (single or CSV import) → group into Lists
      ├─ 4. Launch a Campaign       (agent + list + number → dial)     ← Outbound
      │     or set up a Receptionist (agent + inbound number)          ← Inbound
      │
      ▼
Calls happen → Conversations / Call Logs → Analytics
      │
      ▼
Billing (usage & plan) · Profile & Teams · Support
```

---

## 1. Public site & access

| Page | Purpose | Key actions |
|---|---|---|
| **Landing** (`/`) | Marketing overview (hero, features, stats). | Browse, navigate to Login / Request Access. |
| **Request Access** (`/request-access`) | Lead form for prospective customers. | First/Last name, **Work Email** (req), Company, Phone, User Type → *Submit Request* → "we'll reach out within 24h". |
| **Register** (`/register`) | Create an account. | **Full Name** (req), Company, **Email** (req), **Password** (req, ≥6) → *Create Account* → redirected to dashboard. |
| **Login** (`/login`) | Sign in. | **Email + Password** → *Sign In*. "Forgot password?" → contact admin. |

Auth is JWT-based: login returns a token stored in the browser; every dashboard
request sends it as `Authorization: Bearer <token>`.

---

## 2. Onboarding — Quick Setup

Route: `/dashboard/quick-setup` — the landing page after login.

A **progress bar + 6-item checklist** that auto-detects completion (checks
whether you have agents, numbers, campaigns, integrations, flows, conversations):

1. **Create your first AI Agent** (~5 min)
2. **Get a phone number** (~2 min)
3. **Launch your first campaign** (~10 min)
4. **Connect an integration** (~8 min)
5. **Build your first automation flow** (~12 min)
6. **Review your analytics** (~3 min)

Each incomplete item has a **Start →** button that deep-links to the relevant
section; completed items show a **✓ Done** badge.

---

## 3. Build the agent & voice

### AI Agents (`/dashboard/ai-agents`)
- Grid of agents with search; each card shows name, category, voice, language, status.
- **+ Add New Agent** → 5-step creation wizard (see the agent workflow doc).
- Per agent: **Test** (live voice modal), **Edit** (name, status, voice, language,
  greeting, system prompt), **Duplicate**, **Delete**.

### AI Voices (`/dashboard/ai-voices`)
- Catalog of 8 built-in voices (Aria, Marco, Nora, Kai, Eva, Tom, Lia, Diego) + custom clones.
- **Preview** (text-to-speech demo), **Favorite** (★), **Clone Voice** (custom name/language/accent/gender), **Delete**.

---

## 4. Get a phone number

### Phone Numbers (`/dashboard/telephony/phone-numbers`)
- **+ Buy Number** → choose **provider**:
  - **VAPI** — optionally set an area code; backend provisions a VAPI-managed number. Shows *"Activating M:SS"* for ~2 min, then **Active**.
  - **Twilio** — backend **auto-purchases** a US number on the platform Twilio account and **imports it to VAPI** automatically.
  - Optionally assign an agent + set active.
- Per number: **Test Call** (dial a target number through VAPI), **Edit** (agent/provider/status), **Delete/Release**.

---

## 5. Load your data

### Contacts (`/dashboard/database/contacts`)
- **+ Add Contact** — name, **phone (required)**, email, list, custom fields.
- **Import CSV** — format dialog first (headers `name, phone, email`; **phone required**, email optional; non-CSV rejected) → pick file → *"Imported X, skipped Y with no phone"*.
- Search, view, edit (name/phone/email/list/status), delete.

### Lists (`/dashboard/database/lists`)
- **+ New List** (name) → group contacts for campaigns. View count, rename, delete.

### Custom Fields (`/dashboard/database/custom-fields`)
- **+ Add Field** — name + type (Text/Number/Dropdown/Date/Boolean); dropdown takes comma-separated options; optional "required". Edit/delete.

---

## 6. Run calls

### Outbound — Campaigns (`/dashboard/telephony/outbound`)
- Stats: Total Campaigns, Active Now, Total Contacts, Calls Dialed.
- **+ New Campaign** — name, **agent**, **contact list**, optional phone number.
- Each card: status, agent, number, progress bar (X/Y contacts, %).
- **Start/Resume** → runs **pre-flight checks** (agent synced to VAPI · number active · contacts dialable). All pass → **Launch Campaign** begins dialing; any fail → shows what to fix.
- **Pause**, **Edit**, **Delete**.

### Inbound — AI Receptionist (`/dashboard/telephony/inbound`)
- Stats: Active Receptionists, Total/Completed Inbound Calls, Avg Duration.
- **+ New Receptionist** — name, **VAPI-synced agent**, optional area code → backend provisions an inbound number and links it to the agent.
- Card shows the inbound number (with **copy** button) + status. Edit/delete.
- Recent inbound calls table below (caller, agent, status, duration, AI summary).

---

## 7. Monitor & analyze

### All Conversations (`/dashboard/conversations`)
- 7 stat cards (Total, Completed, Failed, In Progress, Inbound, Outbound).
- Table: channel, contact, phone, duration, status, conversion, time.
- **View** → detail modal with AI summary, transcript, and recording link.

### Inbound Call Logs (`/dashboard/telephony/inbound-logs`)
- Focused log of inbound calls with per-call detail (summary, recording, transcript loaded on demand).

### Analytics (`/dashboard/analytics/...`)
Four views — **Channel · Campaign · Scenario · Flow**:
- KPI cards (total calls, completed, active agents, campaigns).
- 14-day trend line chart (calls / completed / minutes).
- Breakdown below: by channel (bar), by campaign (progress table), or by agent (table).

---

## 8. Account & support

### Billing (`/dashboard/billing`)
- Current plan card (Free / Pay As You Go / Starter / Growth / Business), status, rate/min, renewal, credits.
- **Manage Subscription** → Stripe customer portal.
- Usage meters (Outbound / Inbound / Agents) with green→yellow→red thresholds.
- Plan grid → **Subscribe** → Stripe checkout → back with success.
- Call-cost breakdown table + invoice history (PDF links).

### Profile & Teams (`/dashboard/profile`)
- Edit profile (name, company, phone; email read-only).
- Team table (email, role, permissions, status).
- **Owner only:** **+ Add Collaborator** — email, role (Member/Viewer), permission pills (Create Agents/Campaigns/Contacts, View Conversations/Analytics, Manage Integrations) → *Send Invite*; remove members. (Sub-users cannot delete resources.)

### Support (`/dashboard/support`)
- Help Center, Live Chat hours, support email + a 5-item FAQ accordion.

---

## 9. Admin portal (`/nexus-admin`)

Separate admin login (not a normal user route). Admins can:
- View platform stats (users, conversations, agents, active subscriptions).
- Search users; expand any user to: **enable/disable access**, **adjust credits**,
  **assign plan**, **reset usage**, **set custom limits**, and view metadata
  (join date, Stripe customer ID).

---

## 10. End-to-end example (first live outbound call)

```
Register → Log in → Quick Setup
   │
   1) AI Agents → Create AI Agent (5-step wizard) → agent saved (Postgres + VAPI)
   2) Phone Numbers → Buy Number (Twilio auto-buy → imported to VAPI)
   3) Contacts → Import CSV (phone required) → New List → assign contacts
   4) Outbound → New Campaign (agent + list + number)
        → Start → pre-flight checks pass → Launch → dialing begins
   │
   ▼
Calls run → Conversations (transcripts, recordings) → Analytics (trends)
   │
   ▼
Billing tracks per-minute cost & usage
```

---

*Backing API surface (for reference):* `/auth`, `/agents`, `/contacts`,
`/lists`, `/custom-fields`, `/tools`, `/conversations`, `/telephony/*`
(phone-numbers, campaigns, call, inbound), `/analytics/*`, `/automation/*`,
`/integrations`, `/team`, `/profile`, `/billing/*`, `/admin/*`.
