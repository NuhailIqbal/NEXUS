-- =============================================================================
-- EDM NEXUS — Complete Database Bootstrap
-- =============================================================================
-- This file combines all migrations in the correct order.
-- Safe to paste into Supabase Dashboard → SQL Editor → Run.
-- Fully idempotent: re-running is a no-op.
--
-- Sections:
--   1. Profiles + auth trigger
--   2. Email infrastructure (queues, send log, suppression)
--   3. Core app tables (agents, tools, lists, contacts, automation, conversations, phone_numbers)
--   4. pgmq RPC helpers
--   5. API spec alignment (waitlist, onboarding, integrations, voice_widgets,
--      team_members, custom_fields, outbound_campaigns, inbound_queues,
--      agent_knowledge, automation_runs + column additions + indexes)
-- =============================================================================


-- =============================================================================
-- SECTION 1 — Profiles + auth trigger
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  company_name TEXT,
  phone        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can read own profile"
    ON public.profiles FOR SELECT TO authenticated
    USING (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update own profile"
    ON public.profiles FOR UPDATE TO authenticated
    USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert own profile"
    ON public.profiles FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Auto-create profile row when a new auth user signs up.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- =============================================================================
-- SECTION 2 — Email infrastructure
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net SCHEMA extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    CREATE EXTENSION pg_cron;
  END IF;
END $$;
CREATE EXTENSION IF NOT EXISTS supabase_vault;
CREATE EXTENSION IF NOT EXISTS pgmq;

DO $$ BEGIN PERFORM pgmq.create('auth_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('transactional_emails'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('auth_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;
DO $$ BEGIN PERFORM pgmq.create('transactional_emails_dlq'); EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.email_send_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      TEXT,
  template_name   TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'suppressed', 'failed', 'bounced', 'complained', 'dlq')),
  error_message   TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.email_send_log ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role can read send log"
    ON public.email_send_log FOR SELECT USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can insert send log"
    ON public.email_send_log FOR INSERT WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can update send log"
    ON public.email_send_log FOR UPDATE
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_email_send_log_created   ON public.email_send_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_recipient ON public.email_send_log(recipient_email);
CREATE INDEX IF NOT EXISTS idx_email_send_log_message   ON public.email_send_log(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_log_message_sent_unique
  ON public.email_send_log(message_id) WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS public.email_send_state (
  id                              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  retry_after_until               TIMESTAMPTZ,
  batch_size                      INTEGER NOT NULL DEFAULT 10,
  send_delay_ms                   INTEGER NOT NULL DEFAULT 200,
  auth_email_ttl_minutes          INTEGER NOT NULL DEFAULT 15,
  transactional_email_ttl_minutes INTEGER NOT NULL DEFAULT 60,
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.email_send_state (id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE public.email_send_state ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role can manage send state"
    ON public.email_send_state FOR ALL
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.suppressed_emails (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email      TEXT NOT NULL,
  reason     TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint')),
  metadata   JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(email)
);
ALTER TABLE public.suppressed_emails ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role can read suppressed emails"
    ON public.suppressed_emails FOR SELECT USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can insert suppressed emails"
    ON public.suppressed_emails FOR INSERT WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_suppressed_emails_email ON public.suppressed_emails(email);

CREATE TABLE IF NOT EXISTS public.email_unsubscribe_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token      TEXT NOT NULL UNIQUE,
  email      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ
);
ALTER TABLE public.email_unsubscribe_tokens ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Service role can read tokens"
    ON public.email_unsubscribe_tokens FOR SELECT USING (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can insert tokens"
    ON public.email_unsubscribe_tokens FOR INSERT WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "Service role can mark tokens as used"
    ON public.email_unsubscribe_tokens FOR UPDATE
    USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_token ON public.email_unsubscribe_tokens(token);


-- =============================================================================
-- SECTION 3 — Core app tables
-- =============================================================================

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public;

-- ai_agents
CREATE TABLE IF NOT EXISTS public.ai_agents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Active',
  voice      TEXT,
  language   TEXT,
  category   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.ai_agents ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own ai_agents"   ON public.ai_agents FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own ai_agents" ON public.ai_agents FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own ai_agents" ON public.ai_agents FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own ai_agents" ON public.ai_agents FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- tools
CREATE TABLE IF NOT EXISTS public.tools (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'Active',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.tools ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own tools"   ON public.tools FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own tools" ON public.tools FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own tools" ON public.tools FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own tools" ON public.tools FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP TRIGGER IF EXISTS tools_updated_at ON public.tools;
CREATE TRIGGER tools_updated_at BEFORE UPDATE ON public.tools
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- lists
CREATE TABLE IF NOT EXISTS public.lists (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  contact_count INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.lists ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own lists"   ON public.lists FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own lists" ON public.lists FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own lists" ON public.lists FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own lists" ON public.lists FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- contacts
CREATE TABLE IF NOT EXISTS public.contacts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  phone      TEXT,
  email      TEXT,
  status     TEXT NOT NULL DEFAULT 'Active',
  list_id    UUID REFERENCES public.lists(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own contacts"   ON public.contacts FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own contacts" ON public.contacts FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own contacts" ON public.contacts FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own contacts" ON public.contacts FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- automation_flows
CREATE TABLE IF NOT EXISTS public.automation_flows (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'Active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.automation_flows ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own automation_flows"   ON public.automation_flows FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own automation_flows" ON public.automation_flows FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own automation_flows" ON public.automation_flows FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own automation_flows" ON public.automation_flows FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP TRIGGER IF EXISTS automation_flows_updated_at ON public.automation_flows;
CREATE TRIGGER automation_flows_updated_at BEFORE UPDATE ON public.automation_flows
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- conversations
CREATE TABLE IF NOT EXISTS public.conversations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel      TEXT NOT NULL,
  contact_name TEXT,
  phone        TEXT,
  duration     TEXT,
  status       TEXT NOT NULL DEFAULT 'Initiated',
  conversion   TEXT DEFAULT 'No',
  call_time    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own conversations"   ON public.conversations FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own conversations" ON public.conversations FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own conversations" ON public.conversations FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own conversations" ON public.conversations FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- phone_numbers
CREATE TABLE IF NOT EXISTS public.phone_numbers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  number     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'Active',
  agent_id   UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.phone_numbers ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY "Users can view own phone_numbers"   ON public.phone_numbers FOR SELECT USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can insert own phone_numbers" ON public.phone_numbers FOR INSERT WITH CHECK (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can update own phone_numbers" ON public.phone_numbers FOR UPDATE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY "Users can delete own phone_numbers" ON public.phone_numbers FOR DELETE USING (auth.uid() = user_id); EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- =============================================================================
-- SECTION 4 — pgmq RPC helpers
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enqueue_email(queue_name TEXT, payload JSONB)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN pgmq.send(queue_name, payload);
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN pgmq.send(queue_name, payload);
END;
$$;

CREATE OR REPLACE FUNCTION public.read_email_batch(queue_name TEXT, batch_size INT, vt INT)
RETURNS TABLE(msg_id BIGINT, read_ct INT, message JSONB)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.message FROM pgmq.read(queue_name, vt, batch_size) r;
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_email(queue_name TEXT, message_id BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  RETURN pgmq.delete(queue_name, message_id);
EXCEPTION WHEN undefined_table THEN
  RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.move_to_dlq(source_queue TEXT, dlq_name TEXT, message_id BIGINT, payload JSONB)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE new_id BIGINT;
BEGIN
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  PERFORM pgmq.delete(source_queue, message_id);
  RETURN new_id;
EXCEPTION WHEN undefined_table THEN
  BEGIN PERFORM pgmq.create(dlq_name); EXCEPTION WHEN OTHERS THEN NULL; END;
  SELECT pgmq.send(dlq_name, payload) INTO new_id;
  BEGIN PERFORM pgmq.delete(source_queue, message_id); EXCEPTION WHEN undefined_table THEN NULL; END;
  RETURN new_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB)             FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.enqueue_email(TEXT, JSONB)             TO service_role;
REVOKE EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT)       FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.read_email_batch(TEXT, INT, INT)       TO service_role;
REVOKE EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT)             FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.delete_email(TEXT, BIGINT)             TO service_role;
REVOKE EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.move_to_dlq(TEXT, TEXT, BIGINT, JSONB) TO service_role;


-- =============================================================================
-- SECTION 5 — API Spec alignment (new tables + columns + indexes)
-- =============================================================================

-- ---- waitlist ----
CREATE TABLE IF NOT EXISTS public.waitlist (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name    TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  company_name TEXT,
  use_case     TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can join the waitlist" ON public.waitlist;
CREATE POLICY "Anyone can join the waitlist"
  ON public.waitlist FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);
GRANT INSERT ON public.waitlist TO anon, authenticated;

-- ---- onboarding_progress ----
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
  ON public.onboarding_progress FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS onboarding_progress_updated_at ON public.onboarding_progress;
CREATE TRIGGER onboarding_progress_updated_at BEFORE UPDATE ON public.onboarding_progress
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- agent_knowledge ----
CREATE TABLE IF NOT EXISTS public.agent_knowledge (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id     UUID NOT NULL REFERENCES public.ai_agents(id) ON DELETE CASCADE,
  type         TEXT NOT NULL DEFAULT 'document' CHECK (type IN ('document', 'text')),
  file_name    TEXT,
  storage_path TEXT,
  mime_type    TEXT,
  text_content TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.agent_knowledge ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own agent_knowledge" ON public.agent_knowledge;
CREATE POLICY "Users manage own agent_knowledge"
  ON public.agent_knowledge FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---- integrations ----
CREATE TABLE IF NOT EXISTS public.integrations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  category         TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('voice', 'email', 'other')),
  config_encrypted JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own integrations" ON public.integrations;
CREATE POLICY "Users manage own integrations"
  ON public.integrations FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS integrations_updated_at ON public.integrations;
CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON public.integrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- voice_widgets ----
CREATE TABLE IF NOT EXISTS public.voice_widgets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  agent_id     UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,
  public_token TEXT NOT NULL UNIQUE DEFAULT replace(gen_random_uuid()::text, '-', ''),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.voice_widgets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own voice_widgets" ON public.voice_widgets;
CREATE POLICY "Users manage own voice_widgets"
  ON public.voice_widgets FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS voice_widgets_updated_at ON public.voice_widgets;
CREATE TRIGGER voice_widgets_updated_at BEFORE UPDATE ON public.voice_widgets
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- team_members ----
CREATE TABLE IF NOT EXISTS public.team_members (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  member_email   TEXT NOT NULL,
  member_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  role           TEXT NOT NULL DEFAULT 'Viewer' CHECK (role IN ('Admin', 'Manager', 'Editor', 'Viewer')),
  status         TEXT NOT NULL DEFAULT 'Invited' CHECK (status IN ('Invited', 'Active', 'Removed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, member_email)
);
ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Owners manage their team" ON public.team_members;
CREATE POLICY "Owners manage their team"
  ON public.team_members FOR ALL TO authenticated
  USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);
DROP POLICY IF EXISTS "Members can view their membership" ON public.team_members;
CREATE POLICY "Members can view their membership"
  ON public.team_members FOR SELECT TO authenticated
  USING (auth.uid() = member_user_id);
DROP TRIGGER IF EXISTS team_members_updated_at ON public.team_members;
CREATE TRIGGER team_members_updated_at BEFORE UPDATE ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- custom_fields ----
CREATE TABLE IF NOT EXISTS public.custom_fields (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'Text' CHECK (type IN ('Text', 'Number', 'Dropdown', 'Date', 'Boolean')),
  options       JSONB,
  default_value TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.custom_fields ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own custom_fields" ON public.custom_fields;
CREATE POLICY "Users manage own custom_fields"
  ON public.custom_fields FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS custom_fields_updated_at ON public.custom_fields;
CREATE TRIGGER custom_fields_updated_at BEFORE UPDATE ON public.custom_fields
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- outbound_campaigns ----
CREATE TABLE IF NOT EXISTS public.outbound_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'Inactive' CHECK (status IN ('Active', 'Paused', 'Inactive')),
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
  ON public.outbound_campaigns FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS outbound_campaigns_updated_at ON public.outbound_campaigns;
CREATE TRIGGER outbound_campaigns_updated_at BEFORE UPDATE ON public.outbound_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- inbound_queues ----
CREATE TABLE IF NOT EXISTS public.inbound_queues (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  agent_id         UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL,
  max_wait_seconds INTEGER NOT NULL DEFAULT 120,
  overflow_action  TEXT NOT NULL DEFAULT 'voicemail' CHECK (overflow_action IN ('voicemail', 'hangup', 'transfer')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.inbound_queues ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own inbound_queues" ON public.inbound_queues;
CREATE POLICY "Users manage own inbound_queues"
  ON public.inbound_queues FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP TRIGGER IF EXISTS inbound_queues_updated_at ON public.inbound_queues;
CREATE TRIGGER inbound_queues_updated_at BEFORE UPDATE ON public.inbound_queues
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ---- automation_runs ----
CREATE TABLE IF NOT EXISTS public.automation_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  flow_id       UUID NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
  trigger_event TEXT,
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'success', 'failed')),
  input_data    JSONB,
  output_data   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);
ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users manage own automation_runs" ON public.automation_runs;
CREATE POLICY "Users manage own automation_runs"
  ON public.automation_runs FOR ALL TO authenticated
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ---- Existing tables: additive columns from the API spec ----
ALTER TABLE public.ai_agents      ADD COLUMN IF NOT EXISTS vapi_assistant_id TEXT;
ALTER TABLE public.ai_agents      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
DROP TRIGGER IF EXISTS ai_agents_updated_at ON public.ai_agents;
CREATE TRIGGER ai_agents_updated_at BEFORE UPDATE ON public.ai_agents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS vapi_call_id  TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS transcript    TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS ai_summary    TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS recording_url TEXT;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS agent_id      UUID REFERENCES public.ai_agents(id) ON DELETE SET NULL;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS campaign_id   UUID REFERENCES public.outbound_campaigns(id) ON DELETE SET NULL;
ALTER TABLE public.conversations  ADD COLUMN IF NOT EXISTS scenario_tag  TEXT;

ALTER TABLE public.automation_flows ADD COLUMN IF NOT EXISTS definition JSONB;

ALTER TABLE public.contacts       ADD COLUMN IF NOT EXISTS custom_data JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ---- Indexes ----
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

-- =============================================================================
-- DONE — verify by running:
--   SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;
-- =============================================================================
