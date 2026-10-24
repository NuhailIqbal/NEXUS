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
- **Verify callers before answering** (in **Edit**, off by default) — see [Inbound caller verification](#inbound-caller-verification) below. A number with it on and an agent assigned shows a **Caller check** badge.

### Inbound caller verification
Per number, switchable from **Phone Numbers → Edit** and from each **AI Receptionist** card. When on, the caller's number is looked up before the agent picks up (`GET …/LineTypeLookup`, credentials in `CALLER_LOOKUP_CODE` / `CALLER_LOOKUP_API_KEY`):
- The lookup's `found` flag means **"the line is mobile"**, not "the number exists". `found: true` → the agent answers. `found: false` → the agent never starts: the caller hears *"Sorry, we are unable to take your call. Goodbye."* and the call ends. So landline, VoIP, DNC-listed and invalid numbers are all refused; only mobile numbers get through. (VAPI cannot leave a call literally unanswered; this short message is its way to refuse one.)
- Let through (not refused): a hidden caller id, non-US numbers and extensions (the lookup can't evaluate them), and **any call while the lookup itself fails** (provider down, slow, rejected key) — a third-party outage must not turn real customers away.
- How it works: with the switch on, the number has **no fixed assistant in VAPI** and VAPI asks `POST /webhooks/vapi/inbound` (an `assistant-request`) for each call; the answer is the agent's assistant id or the refusal. With it off, the number is wired straight to its agent as before. Needs `PUBLIC_API_URL` (VAPI must reach the backend); without it, or without the lookup credentials, the switch is locked off with an explanation.
- Every checked call is recorded in `inbound_call_screenings` (caller, answered/refused, reason, line type) and the last few show under **Edit → Recent checks**. API: `GET /telephony/caller-verification/status` and `/log`, toggled with `PATCH /telephony/phone-numbers/{id}` `{caller_verification_enabled}`.
- Interacts with: balance suspension (a verified number is served the shared "unavailable" assistant while the wallet is empty, decided per call; if that assistant has to be created first and VAPI takes over 2 s, the caller hears the "unavailable" sentence instead and the creation finishes in the background), and agent reassignment / receptionist create-update-delete (database-only for a verified number: the agent is looked up per call; also database-only for **any** number while the balance suspends it, the restore then installs whichever agent is assigned). Toggles, settings saves, receptionist changes, balance suspend/restore and the startup re-sync all take a per-number lock, so they cannot interleave and leave VAPI and the database disagreeing.
- **Deploying it (read this before switching it on in production):**
  - VAPI hangs up every call on a verified number if it cannot reach `PUBLIC_API_URL` + `/webhooks/vapi/inbound`. On the apex and default hosts, `nginx/conf.d/nexus.conf` sends unknown paths to the frontend (a POST gets **405**), so that exact path now has its own `location = /webhooks/vapi/inbound` block there (the `api.` host already forwards everything). Run `nginx -t` and reload after deploying the config. `/webhooks/vapi` (call events) was deliberately **not** routed by this change.
  - So a bad setup cannot silently break a line, switching a number **on** first POSTs a harmless `ping` to exactly that URL, with the same secret header, and refuses (customer sees "isn't available yet"; the server log says why) unless this server answers. Loopback `PUBLIC_API_URL`s (`localhost`, `127.x`…) are never available. Where the backend cannot reach its own public address, set `CALLER_VERIFICATION_SKIP_REACHABILITY_CHECK=true`.
  - VAPI keeps the URL and secret it was given when the switch went on. At startup the backend re-points every verified number at the *current* `PUBLIC_API_URL` / `VAPI_WEBHOOK_SECRET` (after waiting for itself to be reachable, retrying with backoff for about 6 minutes; it never re-points at an address that does not answer, and logs an error if it gives up). **Changing either is not seamless:** from the moment the old address/secret stops working until the re-sync finishes (seconds, or longer if the new address is not reachable yet), VAPI cannot reach the routing endpoint and calls on verified numbers are hung up. Change them in a quiet period, or turn verification off on those numbers first. The re-sync only needs `VAPI_API_KEY` and a public `PUBLIC_API_URL` (missing lookup credentials do not stop it: calls are then answered unchecked).
  - Set `VAPI_WEBHOOK_SECRET`. The routing endpoint accepts it as `X-Vapi-Secret` / `Authorization: Bearer` / HMAC `x-vapi-signature`; with no secret configured it is unauthenticated. It has no blanket rate limit (a 429 would drop a live call): only requests that **fail** authentication are limited, 60/min per client IP, so forged or probing traffic cannot use up what VAPI's real requests need.
  - Answered calls on a verified number are logged and billed even if VAPI leaves the call's `assistantId` empty (it chooses the assistant per call): when an event names **no assistant at all** it is attributed by **what this server decided when the call arrived** (an `answered` row in `inbound_call_screenings`, which records the account and the agent), in the webhook and both pull-syncs. So switching verification off mid-call does not make the call free, and a call is never attributed by the number's current setting. Never attributed: refused calls, calls served by the shared "unavailable" assistant or any assistant that is not the account's, calls still in progress (pull-syncs), and calls VAPI ended at routing (`endedReason` starting `assistant-request`, i.e. our refusals or VAPI failing to start the assistant we named). If the agent was deleted since, the call is still logged and billed, just without an agent.

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
- **+ New Campaign** — a six-step wizard (the same one opens from **Settings** on a card): Basics (name, **agent**, phone number, DNC screening), **contact list**, **calling hours**, **auto redial**, **dialing strategy**, review.
- Each card: status, agent, number, progress bar (X/Y contacts, %).
- **Start/Resume** → runs **pre-flight checks** (agent synced to VAPI · number active · contacts dialable · inside calling hours). All pass → **Launch Campaign** begins dialing; any fail → shows what to fix.
- **Pause**, **Edit**, **Delete**.
- **Dialing strategy** (wizard step 5 of 6; Sequential by default for a new campaign; stored in `outbound_campaigns.dial_strategy`, `dial_concurrent_calls`, `dial_calls_per_minute`, `dial_delay_seconds`, all four sent on create and on every save). How the campaign places its calls, and how many at a time:
  - **Sequential**: one call at a time; the next number is dialed when the current call ends.
  - **Concurrent**: up to *Concurrent Calls* (1-20) at once; a new call starts whenever one ends, so the number running stays steady while numbers remain.
  - **Paced**: *Calls per Minute* (1-60) calls started every minute on a steady grid, whether or not earlier calls have ended.
  - **Delay between calls** (0-60 s) applies to every strategy: after a call ends (Sequential), between two placements (Concurrent) or the least time between calls (Paced, so a long delay lowers the real rate and the card says "about N/min"). It is a different setting from the auto-redial "Wait between calls" (minutes).
  - Redials (auto redial) use the same limits as first calls. A number is called once per run, even if it appears twice in the list. An account may have a cap on simultaneous calls (set by an administrator); the wizard, the save and the Start toast then warn when the settings ask for more (`GET /telephony/dialing/limits`, `warnings` on create/save/start), and calls run at the cap.
  - Editing while a campaign runs applies to calls placed from now on; calls already in progress are not touched.
  - **Card:** a Dialing panel with the strategy in short form ("Concurrent · 5 at a time · 2 s gap") and, while the campaign runs, a live panel (Active now / In queue / Placed, "Next call in N s" for Paced, why it is waiting, the last call error, "updated N s ago"). The page polls `GET /telephony/campaigns/live` every 4 s only while a campaign is running and the tab is visible. A campaign with calls still open or redials still queued is not shown as Completed. The numbers view shows each call's slot and wave.
  - **Start** answers as soon as the first calls are placed (the rest of the list is dialed in the background); the toast reads "Campaign started: 5 calls placed, 118 numbers queued (5 at a time)". Start on a campaign that is already running is a harmless 200 ("already running"), not an error. The SPA uses Resume only for a Paused campaign with an open run; anything else is a Start.
- **Calling hours** (wizard step 3 of 6, and **Settings** on the card; off by default = calls at any time). Pick a timezone, days and start/end times with the same pickers as the Callbacks settings. With them on:
  - The campaign **will not start while closed** (the pre-flight check fails and says when it opens; the API answers 400 with the same text).
  - A run that is still going when the hours end **stops before its next call** (the hours are checked before every call, in every strategy); calls already placed are not interrupted. The campaign is parked as **Paused** with `outbound_campaigns.dial_cursor` set to the last contact handled (contacts are dialed in upload order), and the card says it stopped partway.
  - **Start/Resume** during open hours carries on with the contacts **after** that one, so nobody is called twice; the place is forgotten when the list is finished or the campaign's list is changed. The page toast reports how many were called and how many are left.
  - **It continues by itself.** When the hours stop a run, the campaign is parked as Paused with `dial_cursor` (the last contact handled) and `stopped_by_hours_at` (the "continue automatically" marker). A background sweep (`services/campaign_scheduler.py`, every `CAMPAIGN_SWEEP_INTERVAL_SECONDS`, default 60, 0 = off) starts every such campaign again as soon as its hours are open, through the same code as the Start button, from the contact after the cursor. If that run is cut off again it waits for the next opening, day after day, until the list is finished. The card says "continues automatically … (Tue, Oct 14, 9:00 AM GMT+5)" and has a **Stop auto-resume** link; the owner gets an in-app notification each time it continued.
  - **A person always wins.** The marker is cleared by anything a person does: Pause (the place is kept, Start/Resume still carries on from it), setting the status to another value, changing the list, switching the hours off, or pressing Start. Saving the settings with the same status and hours keeps it waiting. Only campaigns carrying the marker are touched (an older or deliberately paused campaign never starts by itself), and the marker is claimed atomically so two sweeps can never start one campaign twice.
  - **One run at a time.** Starting a run takes a short claim on the campaign (`run_token` + `run_heartbeat_at`) only while a dispatch tick runs; a double click on Start, the Start button racing the automatic continuing, or a Pause followed by an immediate Start can never both dial. Start on a campaign that is already running answers 200 `already_running` and changes nothing (there is no 409). A claim that nothing has refreshed for 60 seconds is stale and is taken over.
  - **While a run is going:** the campaign is Active. **Before every call** it is read again: a Pause or any other status change, a different list or deleting it ends the run there (calls already placed are not interrupted), and the latest calling hours count (narrowed: it stops at once and the new hours decide when it continues; switched off: no limit any more). A person's choice also wins over the hours: a run paused by hand is never re-armed to continue by itself.
  - **The place is saved after each group of calls is handed out** (`dial_seq` / `dial_cursor`), and a number that was not actually placed is picked up again, so a crash or restart never skips a number; a number is never on two calls at once. If something breaks mid-run the campaign is parked as Paused (not left looking Active) and Start carries on from the saved place.
  - **If it cannot start** (empty wallet, agent no longer set up, ...) it is not retried every minute: the owner is notified once, the campaign stays Paused with its place, and Start carries on after the problem is fixed.
  - **Schedule type** (campaigns only; stored in the one JSON column `outbound_campaigns.call_hours_schedule`, `{}` = same every day, no breaks). *Same schedule every day* (the default) is the days + start/end above, plus **breaks**. *Custom schedule per day* lists Monday-Sunday: each day is switched on or off and has its own start, end and breaks, with a **Copy to all days** button (copies that day's hours and breaks to every other day that is switched on; days that are off stay off). Switching to the custom view starts from the current shared schedule. In a custom schedule the plain `call_hours_days` / `_start` / `_end` columns are derived by the server (the days that are on, the earliest start, the latest end), so they stay a valid summary.
  - **Breaks.** One or more `{start, end}` inside a day's window (shared, or per day). During a break nothing new starts; the open time of a day is its window minus its breaks. A run that reaches a break stops between batches exactly like at closing time (calls already placed are never cut), is parked as Paused with its place and the auto-resume marker, and the background sweep carries it on from the next contact as soon as the break ends (within one sweep interval); the card and the 400 on Start say when it opens again (the end of the break counts as an opening). Rules, checked in the form (inline, next to the field) and again by the server (400 with the reason, naming the day in a custom schedule): end after start, every break inside that day's window (touching the edges is fine), breaks must not overlap (touching is fine), breaks must leave some time to run, at most 10 per day, and for a custom schedule at least one day on. Times are minutes in the campaign's chosen time zone (DST-safe: the wall clock decides).
  - Inbound receptionist hours are unchanged (one window, no breaks, no per-day).
  - A window cannot cross midnight (end must be after start; an end of 12:00 AM means the end of the day). An unreadable stored setting counts as closed.
  - Note: how fast the list is worked through is set by the dialing strategy (one at a time, up to 20 at once, or a steady rate), so the hours cut a run off whenever the list is still being dialed at closing time; there is no daily pacing / per-day limit.
  - **Time zone:** the user chooses it; there is **no default** anywhere (empty "Select time zone" field, with an optional "Use my time zone (…)" link that only fills it on click). It is required once the hours are on (400 "Select a time zone." otherwise) and stored as NULL until chosen. Any zone the picker offers works (418 in the browser list; the server accepts every IANA name Python knows): the window, the weekday, the "opens again …" text and the next-opening time are all worked out in THAT zone, including half-hour/45-minute offsets and daylight-saving changes.
  - API: `call_hours_enabled`, `call_hours_timezone`, `call_hours_days` (Monday = 0), `call_hours_start`, `call_hours_end`, `call_hours_schedule` (`{"mode": "same", "breaks": [{"start","end"}]}` or `{"mode": "per_day", "days": {"0": {"on", "start", "end", "breaks"}, ...}}`) on `POST`/`PATCH /telephony/campaigns`; each campaign in the list carries `call_hours_state` (`enabled`, `open`, `next_open_at`, `summary`). Logic: `backend/services/call_hours.py`.

### Inbound — AI Receptionist (`/dashboard/telephony/inbound`)
- Stats: Active Receptionists, Total/Completed Inbound Calls, Avg Duration.
- **+ New Receptionist** — name, **VAPI-synced agent**, optional area code → backend provisions an inbound number and links it to the agent.
- Card shows the inbound number (with **copy** button) + status. Edit/delete.
- Each card has a **Verify callers before answering** switch (the same per-number setting as Phone Numbers → Edit): on = only mobile callers reach the agent.
- **Answering hours** (card **Settings**, off by default = answers around the clock; stored on the receptionist's number as `phone_numbers.answer_hours_*`). Same pickers as above. Outside them the caller hears *"Sorry, we are closed right now. Please call back during our opening hours. Goodbye."* and the call ends (the agent never starts, and the call is never logged or billed to the customer); the card shows **Open now** / **Closed — opens …**.
  - How it works: like caller verification, a number with hours on has **no fixed assistant in VAPI**; VAPI asks `POST /webhooks/vapi/inbound` per call and the server answers with the agent or the closed message, so it is exact to the second. The hours check comes **first** (before balance suspension and caller verification); inside the hours, verification (if on) still applies. Calls answered inside the hours are recorded in `inbound_call_screenings` (`within_hours`) so they are logged and billed even when VAPI omits the assistant id; refusals are recorded as `outside_hours`.
  - Needs only `VAPI_API_KEY` and a public `PUBLIC_API_URL` (not the caller-lookup credentials); without them the switch is locked off with an explanation (`GET /telephony/answer-hours/status`). The deployment notes under *Inbound caller verification* apply in full (nginx route for `/webhooks/vapi/inbound`, `VAPI_WEBHOOK_SECRET`, reachability check on switch-on, startup re-sync, changing `PUBLIC_API_URL` is not seamless).
  - Every code path that writes a number's assistant treats "hours on" like "verification on" (`caller_verification.server_routed`): agent changes, receptionist create/update/delete and balance suspend/restore are database-only for such a number. If the stored hours cannot be read, the line stays **open** (never drop a real caller), including on the error path.
  - API: `answer_hours_enabled`, `answer_hours_timezone`, `answer_hours_days`, `answer_hours_start`, `answer_hours_end` on `PATCH /telephony/phone-numbers/{id}`; each number in the list carries `answer_hours_state`.
- Recent inbound calls table below (caller, agent, status, duration, AI summary).

### Time zones in the call logs (Inbound Logs, Outbound Logs, All Conversations)
Every time shown for a call (the Time column, the details dialog, the events inside a call) is in the time zone the user chose for **what handled that call**, and always carries the zone's name ("Oct 14, 2026, 9:45 AM GMT+5:45"):
- **Inbound call** → the answering-hours time zone of the NEXUS number it came in on (`conversations.phone_number_id`, found from VAPI's phone id when the call is logged).
- **Outbound call** → the calling-hours time zone of the campaign that dialed it (`conversations.campaign_id`, from `campaign_calls`, written when the campaign places the call); a call placed by the callback scheduler uses the zone that callback was scheduled in.
- The server resolves this per row (`display_timezone` on `GET /conversations` and `/conversations/{id}`) from the zone chosen **now**, so changing a campaign's or number's zone re-renders its calls in the new zone. The stored moment is never changed (still one UTC instant).
- Calls with no chosen zone (logged before this existed, or from a number/campaign that never had one chosen) are shown in the viewer's own zone, named, never in a made-up default.
- Not covered: the "Date" filter on All Conversations (`call_date`) still reads the calendar day in the database session's zone, and billing/admin screens show times in the viewer's zone.

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
