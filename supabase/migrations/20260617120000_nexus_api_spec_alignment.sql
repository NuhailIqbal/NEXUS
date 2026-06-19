-- =============================================================================
-- EDM Nexus — API Spec Alignment
-- Brings the schema in line with the Complete API Specification (21 screens).
-- Additive + idempotent: safe to apply on top of the existing schema.
--
-- Conventions (matching existing migrations):
--   * public schema, UUID PKs via gen_random_uuid()
--   * per-user ownership: user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE
--   * RLS enabled, scoped to the owning user (auth.uid() = user_id)
--   * shared public.update_updated_at_column() trigger for updated_at
--
-- NOTE: business logic (VAPI dialing, encryption, analytics aggregation,
-- automation execution) lives in the API layer (currently Supabase, moving to
-- Python). This file defines storage + integrity + access control only, so it
-- is fully portable to the future Python backend.
-- =============================================================================

-- Ensure the shared updated_at trigger function exists (idempotent).
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;


-- =============================================================================
-- SCREEN 1 — Waitlist (/request-access)
-- Pre-auth: anonymous visitors submit. Unique email enforces the 409 conflict.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  company_name TEXT,
  use_case     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Anyone may submit; nobody reads via the public API (admin uses service role).
DROP POLICY IF EXISTS "Anyone can join the waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join the waitlist"
  ON public.waitlist FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
GRANT INSERT ON public.waitlist TO anon, authenticated;


-- =============================================================================
-- SCREEN 2 — Onboarding progress (/dashboard/quick-setup)
-- One row per (user, step_key). 6 known steps; app upserts completion.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.onboarding_progress (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  step_key   TEXT NOT NULL,
  completed  BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, step_key)
);
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own onboarding_progress" ON public.onboarding_progress;
CREATE POLICY "Users manage own onboarding_progress"
  ON public.onboarding_progress FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS onboarding_progress_updated_at ON public.onboarding_progress;
CREATE TRIGGER onboarding_progress_updated_at BEFORE UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 4 — Agent knowledge docs (/agents/{id}/knowledge)
-- Documents go to Supabase Storage; we persist a pointer + extracted text.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.agent_knowledge (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'document'
               CHECK (type IN ('document', 'text')),
  file_name    TEXT,
  storage_path TEXT,          -- path in the storage bucket (when type = document)
  mime_type    TEXT,
  text_content TEXT,          -- inline text (when type = text) or extracted text
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_knowledge ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own agent_knowledge" ON public.agent_knowledge;
CREATE POLICY "Users manage own agent_knowledge"
  ON public.agent_knowledge FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- =============================================================================
-- SCREEN 6 — Integrations (/dashboard/integrations)
-- Secrets (api_key, sip password, ...) are encrypted by the API layer before
-- storage; this column holds ciphertext/opaque JSON and is returned masked.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.integrations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'Active'
                    CHECK (status IN ('Active', 'Inactive')),
  category          TEXT NOT NULL DEFAULT 'other'
                    CHECK (category IN ('voice', 'email', 'other')),
  config_encrypted  JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own integrations" ON public.integrations;
CREATE POLICY "Users manage own integrations"
  ON public.integrations FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS integrations_updated_at ON public.integrations;
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 7 — Voice widgets (/dashboard/voice-widgets)
-- public_token backs the embed URL (https://app.edmnexus.com/widget/<token>).
-- Public resolution of the widget is served by the API layer (service role),
-- not by anonymous direct table access.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.voice_widgets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  agent_id     UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'Active'
               CHECK (status IN ('Active', 'Inactive')),
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_token TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_widgets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own voice_widgets" ON public.voice_widgets;
CREATE POLICY "Users manage own voice_widgets"
  ON public.voice_widgets FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS voice_widgets_updated_at ON public.voice_widgets;
CREATE TRIGGER voice_widgets_updated_at BEFORE UPDATE ON public.voice_widgets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 9 — Team members (/dashboard/profile/team)
-- Invite by email; member_user_id is filled once the invitee accepts/signs up.
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.team_members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_email   TEXT NOT NULL,
  member_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role           TEXT NOT NULL DEFAULT 'Viewer'
                 CHECK (role IN ('Admin', 'Manager', 'Editor', 'Viewer')),
  status         TEXT NOT NULL DEFAULT 'Invited'
                 CHECK (status IN ('Invited', 'Active', 'Removed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, member_email)
);
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

-- The account owner manages their team roster.
DROP POLICY IF EXISTS "Owners manage their team" ON public.team_members;
CREATE POLICY "Owners manage their team"
  ON public.team_members FOR ALL
  TO authenticated
  USING (auth.uid() = owner_id)
  WITH CHECK (auth.uid() = owner_id);

-- A member can see the teams they belong to.
DROP POLICY IF EXISTS "Members can view their membership" ON public.team_members;
CREATE POLICY "Members can view their membership"
  ON public.team_members FOR SELECT
  TO authenticated
  USING (auth.uid() = member_user_id);

DROP TRIGGER IF EXISTS team_members_updated_at ON public.team_members;
CREATE TRIGGER team_members_updated_at BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 12 — Custom field definitions (/dashboard/database/custom-fields)
-- Field VALUES per contact are stored in contacts.custom_data (added below).
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'Text'
                CHECK (type IN ('Text', 'Number', 'Dropdown', 'Date', 'Boolean')),
  options       JSONB,        -- choices when type = Dropdown
  default_value TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own custom_fields" ON public.custom_fields;
CREATE POLICY "Users manage own custom_fields"
  ON public.custom_fields FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS custom_fields_updated_at ON public.custom_fields;
CREATE TRIGGER custom_fields_updated_at BEFORE UPDATE ON public.custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 13 — Outbound campaigns (/dashboard/telephony/outbound)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.outbound_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Inactive'
                  CHECK (status IN ('Active', 'Paused', 'Inactive')),
  agent_id        UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  list_id         UUID REFERENCES public.lists(id) ON DELETE SET NULL,
  contacts_count  INTEGER NOT NULL DEFAULT 0,
  completed_count INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.outbound_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own outbound_campaigns" ON public.outbound_campaigns;
CREATE POLICY "Users manage own outbound_campaigns"
  ON public.outbound_campaigns FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS outbound_campaigns_updated_at ON public.outbound_campaigns;
CREATE TRIGGER outbound_campaigns_updated_at BEFORE UPDATE ON public.outbound_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 14 — Inbound queues (/dashboard/telephony/inbound)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.inbound_queues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Active'
                   CHECK (status IN ('Active', 'Inactive')),
  agent_id         UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  max_wait_seconds INTEGER NOT NULL DEFAULT 120,
  overflow_action  TEXT NOT NULL DEFAULT 'voicemail'
                   CHECK (overflow_action IN ('voicemail', 'hangup', 'transfer')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.inbound_queues ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own inbound_queues" ON public.inbound_queues;
CREATE POLICY "Users manage own inbound_queues"
  ON public.inbound_queues FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP TRIGGER IF EXISTS inbound_queues_updated_at ON public.inbound_queues;
CREATE TRIGGER inbound_queues_updated_at BEFORE UPDATE ON public.inbound_queues
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- =============================================================================
-- SCREEN 20/21 — Automation runs (execution log for automation_flows)
-- =============================================================================
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_id       UUID NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
  trigger_event TEXT,
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'success', 'failed')),
  input_data    JSONB,
  output_data   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own automation_runs" ON public.automation_runs;
CREATE POLICY "Users manage own automation_runs"
  ON public.automation_runs FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- =============================================================================
-- Existing tables — additive columns required by the spec
-- =============================================================================

-- VAPI linkage + agent edit timestamp
ALTER TABLE public.ai_agents      ADD COLUMN IF NOT EXISTS vapi_assistant_id TEXT;
ALTER TABLE public.ai_agents      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS ai_agents_updated_at ON public.ai_agents;
CREATE TRIGGER ai_agents_updated_at BEFORE UPDATE ON public.ai_agents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Conversation enrichment from VAPI webhooks + analytics joins
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS vapi_call_id  TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS transcript    TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS ai_summary    TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS agent_id      UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS campaign_id   UUID REFERENCES public.outbound_campaigns(id) ON DELETE SET NULL;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS scenario_tag  TEXT;  -- for /analytics/scenario

-- Flow Editor canvas (nodes + edges + viewport)
ALTER TABLE public.automation_flows ADD COLUMN IF NOT EXISTS definition JSONB;

-- Per-contact custom field values (keyed by custom_fields.id or name)
ALTER TABLE public.contacts       ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;


-- =============================================================================
-- Indexes — owner scans (RLS), foreign keys, and common filters/sorts
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_onboarding_progress_user   ON public.onboarding_progress (user_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_user       ON public.agent_knowledge (user_id);
CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent      ON public.agent_knowledge (agent_id);
CREATE INDEX IF NOT EXISTS idx_integrations_user          ON public.integrations (user_id);
CREATE INDEX IF NOT EXISTS idx_integrations_category      ON public.integrations (user_id, category);
CREATE INDEX IF NOT EXISTS idx_voice_widgets_user         ON public.voice_widgets (user_id);
CREATE INDEX IF NOT EXISTS idx_team_members_owner         ON public.team_members (owner_id);
CREATE INDEX IF NOT EXISTS idx_team_members_member        ON public.team_members (member_user_id);
CREATE INDEX IF NOT EXISTS idx_custom_fields_user         ON public.custom_fields (user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_user    ON public.outbound_campaigns (user_id);
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_agent   ON public.outbound_campaigns (agent_id);
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_list    ON public.outbound_campaigns (list_id);
CREATE INDEX IF NOT EXISTS idx_inbound_queues_user        ON public.inbound_queues (user_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_user       ON public.automation_runs (user_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_flow       ON public.automation_runs (flow_id);

-- Existing tables: indexes for the list/filter/sort patterns in the spec
CREATE INDEX IF NOT EXISTS idx_ai_agents_user             ON public.ai_agents (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_agents_status           ON public.ai_agents (user_id, status);
CREATE INDEX IF NOT EXISTS idx_tools_user                 ON public.tools (user_id);
CREATE INDEX IF NOT EXISTS idx_lists_user                 ON public.lists (user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_user              ON public.contacts (user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_list              ON public.contacts (list_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status            ON public.contacts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_user         ON public.phone_numbers (user_id);
CREATE INDEX IF NOT EXISTS idx_phone_numbers_agent        ON public.phone_numbers (agent_id);
CREATE INDEX IF NOT EXISTS idx_automation_flows_user      ON public.automation_flows (user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_user_time    ON public.conversations (user_id, call_time DESC);
CREATE INDEX IF NOT EXISTS idx_conversations_status       ON public.conversations (user_id, status);
CREATE INDEX IF NOT EXISTS idx_conversations_vapi_call    ON public.conversations (vapi_call_id);
CREATE INDEX IF NOT EXISTS idx_conversations_campaign     ON public.conversations (campaign_id);
CREATE INDEX IF NOT EXISTS idx_conversations_agent        ON public.conversations (agent_id);
