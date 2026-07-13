--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;

--
-- Local users table (replaces Supabase auth.users)
-- gen_random_uuid() is built into PostgreSQL 13+, so no extension is required.
--
CREATE TABLE IF NOT EXISTS public.users (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email               text UNIQUE NOT NULL,
    encrypted_password  text,
    raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
    email_confirmed_at  timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.refresh_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token       text UNIQUE NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    token       text UNIQUE NOT NULL,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);



--
-- Name: delete_email(text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.delete_email(queue_name text, message_id bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN pgmq.delete(queue_name, message_id);
EXCEPTION WHEN undefined_table THEN
  RETURN FALSE;
END;
$$;


--
-- Name: enqueue_email(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.enqueue_email(queue_name text, payload jsonb) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN pgmq.send(queue_name, payload);
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN pgmq.send(queue_name, payload);
END;
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, NEW.raw_user_meta_data ->> 'full_name')
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: move_to_dlq(text, text, bigint, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.move_to_dlq(source_queue text, dlq_name text, message_id bigint, payload jsonb) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: read_email_batch(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.read_email_batch(queue_name text, batch_size integer, vt integer) RETURNS TABLE(msg_id bigint, read_ct integer, message jsonb)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.message FROM pgmq.read(queue_name, vt, batch_size) r;
EXCEPTION WHEN undefined_table THEN
  PERFORM pgmq.create(queue_name);
  RETURN;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE OR REPLACE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_knowledge; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.agent_knowledge (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    agent_id uuid NOT NULL,
    type text DEFAULT 'document'::text NOT NULL,
    file_name text,
    storage_path text,
    mime_type text,
    text_content text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT agent_knowledge_type_check CHECK ((type = ANY (ARRAY['document'::text, 'text'::text])))
);


--
-- Name: ai_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.ai_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    voice text,
    language text,
    category text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vapi_assistant_id text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    system_prompt text,
    first_message text,
    main_goal text,
    website text,
    selected_tool_keys text[] DEFAULT '{}'::text[] NOT NULL,
    transfer_number text,
    transfer_tool_id text
);


--
-- Name: automation_flow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.automation_flow_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    flow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    version_number integer NOT NULL,
    definition jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: automation_flows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.automation_flows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'Active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    definition jsonb
);


--
-- Name: automation_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.automation_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    flow_id uuid NOT NULL,
    trigger_event text,
    status text DEFAULT 'queued'::text NOT NULL,
    input_data jsonb,
    output_data jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT automation_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: billing; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.billing (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan text DEFAULT 'free'::text,
    status text DEFAULT 'inactive'::text,
    stripe_customer_id text,
    stripe_subscription_id text,
    current_period_end timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    outbound_limit integer DEFAULT 5,
    inbound_limit integer DEFAULT 5,
    outbound_used integer DEFAULT 0,
    inbound_used integer DEFAULT 0,
    agents_limit integer DEFAULT 10,
    credits integer DEFAULT 0,
    is_active boolean DEFAULT true,
    rate_per_minute numeric(6,4) DEFAULT 0.05,
    total_charges numeric(10,2) DEFAULT 0.00,
    balance numeric(10,2) DEFAULT 0.00
);


--
-- Name: contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    status text DEFAULT 'Active'::text NOT NULL,
    list_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    custom_data jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    channel text NOT NULL,
    contact_name text,
    phone text,
    duration text,
    status text DEFAULT 'Initiated'::text NOT NULL,
    conversion text DEFAULT 'No'::text,
    call_time timestamp with time zone DEFAULT now() NOT NULL,
    vapi_call_id text,
    transcript text,
    ai_summary text,
    recording_url text,
    agent_id uuid,
    campaign_id uuid,
    scenario_tag text,
    contact_id uuid,
    direction text DEFAULT 'outbound'::text,
    duration_seconds integer DEFAULT 0,
    call_cost numeric(8,4) DEFAULT 0.00,
    qualified boolean DEFAULT false,
    transferred_to text,
    CONSTRAINT conversations_direction_check CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound'::text])))
);


--
-- Name: custom_fields; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.custom_fields (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    type text DEFAULT 'Text'::text NOT NULL,
    options jsonb,
    default_value text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT custom_fields_type_check CHECK ((type = ANY (ARRAY['Text'::text, 'Number'::text, 'Dropdown'::text, 'Date'::text, 'Boolean'::text])))
);


--
-- Name: email_send_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.email_send_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id text,
    template_name text NOT NULL,
    recipient_email text NOT NULL,
    status text NOT NULL,
    error_message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_send_log_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'suppressed'::text, 'failed'::text, 'bounced'::text, 'complained'::text, 'dlq'::text])))
);


--
-- Name: email_send_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.email_send_state (
    id integer DEFAULT 1 NOT NULL,
    retry_after_until timestamp with time zone,
    batch_size integer DEFAULT 10 NOT NULL,
    send_delay_ms integer DEFAULT 200 NOT NULL,
    auth_email_ttl_minutes integer DEFAULT 15 NOT NULL,
    transactional_email_ttl_minutes integer DEFAULT 60 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_send_state_id_check CHECK ((id = 1))
);


--
-- Name: email_unsubscribe_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.email_unsubscribe_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    email text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    used_at timestamp with time zone
);


--
-- Name: inbound_queues; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.inbound_queues (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    agent_id uuid,
    max_wait_seconds integer DEFAULT 120 NOT NULL,
    overflow_action text DEFAULT 'voicemail'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    phone_number_id uuid,
    CONSTRAINT inbound_queues_overflow_action_check CHECK ((overflow_action = ANY (ARRAY['voicemail'::text, 'hangup'::text, 'transfer'::text]))),
    CONSTRAINT inbound_queues_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Inactive'::text])))
);


--
-- Name: integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'Active'::text NOT NULL,
    category text DEFAULT 'other'::text NOT NULL,
    config_encrypted jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT integrations_category_check CHECK ((category = ANY (ARRAY['voice'::text, 'email'::text, 'other'::text]))),
    CONSTRAINT integrations_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Inactive'::text])))
);


--
-- Name: lists; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    contact_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: onboarding_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.onboarding_progress (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    step_key text NOT NULL,
    completed boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: outbound_campaigns; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.outbound_campaigns (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'Inactive'::text NOT NULL,
    agent_id uuid,
    list_id uuid,
    contacts_count integer DEFAULT 0 NOT NULL,
    completed_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    vapi_campaign_id text,
    phone_number_id uuid,
    CONSTRAINT outbound_campaigns_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Paused'::text, 'Inactive'::text])))
);


--
-- Name: phone_numbers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.phone_numbers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    number text NOT NULL,
    status text DEFAULT 'Active'::text NOT NULL,
    agent_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vapi_phone_id text,
    provider text DEFAULT 'vapi'::text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    twilio_sid text,
    monthly_cost numeric(6,2) DEFAULT 1.15,
    label text
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.profiles (
    id uuid NOT NULL,
    full_name text,
    company_name text,
    phone text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: suppressed_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.suppressed_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    reason text NOT NULL,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT suppressed_emails_reason_check CHECK ((reason = ANY (ARRAY['unsubscribe'::text, 'bounce'::text, 'complaint'::text])))
);


--
-- Name: team_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.team_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_id uuid NOT NULL,
    member_email text NOT NULL,
    member_user_id uuid,
    role text DEFAULT 'Viewer'::text NOT NULL,
    status text DEFAULT 'Invited'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    permissions jsonb DEFAULT '["create_agents", "create_campaigns", "create_contacts", "view_conversations", "view_analytics"]'::jsonb,
    CONSTRAINT team_members_role_check CHECK ((role = ANY (ARRAY['Admin'::text, 'Manager'::text, 'Editor'::text, 'Viewer'::text]))),
    CONSTRAINT team_members_status_check CHECK ((status = ANY (ARRAY['Invited'::text, 'Active'::text, 'Removed'::text])))
);


--
-- Name: tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    status text DEFAULT 'Active'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    vapi_tool_id text,
    url text,
    method text DEFAULT 'POST'::text,
    headers jsonb DEFAULT '{}'::jsonb,
    parameters jsonb DEFAULT '[]'::jsonb
);


--
-- Name: voice_widgets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.voice_widgets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    agent_id uuid,
    status text DEFAULT 'Active'::text NOT NULL,
    config jsonb DEFAULT '{}'::jsonb NOT NULL,
    public_token text DEFAULT replace((gen_random_uuid())::text, '-'::text, ''::text) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_widgets_status_check CHECK ((status = ANY (ARRAY['Active'::text, 'Inactive'::text])))
);


--
-- Name: waitlist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE IF NOT EXISTS public.waitlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    full_name text NOT NULL,
    email text NOT NULL,
    company_name text,
    use_case text,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT waitlist_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: agent_knowledge agent_knowledge_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_knowledge
    ADD CONSTRAINT agent_knowledge_pkey PRIMARY KEY (id);


--
-- Name: ai_agents ai_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_pkey PRIMARY KEY (id);


--
-- Name: automation_flow_versions automation_flow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_flow_versions
    ADD CONSTRAINT automation_flow_versions_pkey PRIMARY KEY (id);


--
-- Name: automation_flows automation_flows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_flows
    ADD CONSTRAINT automation_flows_pkey PRIMARY KEY (id);


--
-- Name: automation_runs automation_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_pkey PRIMARY KEY (id);


--
-- Name: billing billing_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing
    ADD CONSTRAINT billing_pkey PRIMARY KEY (id);


--
-- Name: billing billing_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing
    ADD CONSTRAINT billing_user_id_key UNIQUE (user_id);


--
-- Name: contacts contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: custom_fields custom_fields_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_pkey PRIMARY KEY (id);


--
-- Name: email_send_log email_send_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_send_log
    ADD CONSTRAINT email_send_log_pkey PRIMARY KEY (id);


--
-- Name: email_send_state email_send_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_send_state
    ADD CONSTRAINT email_send_state_pkey PRIMARY KEY (id);


--
-- Name: email_unsubscribe_tokens email_unsubscribe_tokens_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_unsubscribe_tokens
    ADD CONSTRAINT email_unsubscribe_tokens_email_key UNIQUE (email);


--
-- Name: email_unsubscribe_tokens email_unsubscribe_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_unsubscribe_tokens
    ADD CONSTRAINT email_unsubscribe_tokens_pkey PRIMARY KEY (id);


--
-- Name: email_unsubscribe_tokens email_unsubscribe_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_unsubscribe_tokens
    ADD CONSTRAINT email_unsubscribe_tokens_token_key UNIQUE (token);


--
-- Name: inbound_queues inbound_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_queues
    ADD CONSTRAINT inbound_queues_pkey PRIMARY KEY (id);


--
-- Name: integrations integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_pkey PRIMARY KEY (id);


--
-- Name: lists lists_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_pkey PRIMARY KEY (id);


--
-- Name: onboarding_progress onboarding_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_pkey PRIMARY KEY (id);


--
-- Name: onboarding_progress onboarding_progress_user_id_step_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_user_id_step_key_key UNIQUE (user_id, step_key);


--
-- Name: outbound_campaigns outbound_campaigns_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_campaigns
    ADD CONSTRAINT outbound_campaigns_pkey PRIMARY KEY (id);


--
-- Name: phone_numbers phone_numbers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: suppressed_emails suppressed_emails_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppressed_emails
    ADD CONSTRAINT suppressed_emails_email_key UNIQUE (email);


--
-- Name: suppressed_emails suppressed_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.suppressed_emails
    ADD CONSTRAINT suppressed_emails_pkey PRIMARY KEY (id);


--
-- Name: team_members team_members_owner_id_member_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_owner_id_member_email_key UNIQUE (owner_id, member_email);


--
-- Name: team_members team_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_pkey PRIMARY KEY (id);


--
-- Name: tools tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_pkey PRIMARY KEY (id);


--
-- Name: voice_widgets voice_widgets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_widgets
    ADD CONSTRAINT voice_widgets_pkey PRIMARY KEY (id);


--
-- Name: voice_widgets voice_widgets_public_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_widgets
    ADD CONSTRAINT voice_widgets_public_token_key UNIQUE (public_token);


--
-- Name: waitlist waitlist_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_email_key UNIQUE (email);


--
-- Name: waitlist waitlist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.waitlist
    ADD CONSTRAINT waitlist_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_knowledge_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_agent ON public.agent_knowledge USING btree (agent_id);


--
-- Name: idx_agent_knowledge_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_agent_knowledge_user ON public.agent_knowledge USING btree (user_id);


--
-- Name: idx_ai_agents_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ai_agents_status ON public.ai_agents USING btree (user_id, status);


--
-- Name: idx_ai_agents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_ai_agents_user ON public.ai_agents USING btree (user_id);


--
-- Name: idx_automation_flows_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_automation_flows_user ON public.automation_flows USING btree (user_id);


--
-- Name: idx_automation_runs_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_automation_runs_flow ON public.automation_runs USING btree (flow_id);


--
-- Name: idx_automation_runs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_automation_runs_user ON public.automation_runs USING btree (user_id);


--
-- Name: idx_contacts_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_contacts_list ON public.contacts USING btree (list_id);


--
-- Name: idx_contacts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_contacts_status ON public.contacts USING btree (user_id, status);


--
-- Name: idx_contacts_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_contacts_user ON public.contacts USING btree (user_id);


--
-- Name: idx_conversations_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_conversations_agent ON public.conversations USING btree (agent_id);


--
-- Name: idx_conversations_campaign; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_conversations_campaign ON public.conversations USING btree (campaign_id);


--
-- Name: idx_conversations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_conversations_status ON public.conversations USING btree (user_id, status);


--
-- Name: idx_conversations_user_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_conversations_user_time ON public.conversations USING btree (user_id, call_time DESC);


--
-- Name: idx_conversations_vapi_call; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_conversations_vapi_call ON public.conversations USING btree (vapi_call_id);


--
-- Name: idx_custom_fields_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_custom_fields_user ON public.custom_fields USING btree (user_id);


--
-- Name: idx_email_send_log_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_email_send_log_created ON public.email_send_log USING btree (created_at DESC);


--
-- Name: idx_email_send_log_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_email_send_log_message ON public.email_send_log USING btree (message_id);


--
-- Name: idx_email_send_log_message_sent_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX IF NOT EXISTS idx_email_send_log_message_sent_unique ON public.email_send_log USING btree (message_id) WHERE (status = 'sent'::text);


--
-- Name: idx_email_send_log_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_email_send_log_recipient ON public.email_send_log USING btree (recipient_email);


--
-- Name: idx_flow_versions_flow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_flow_versions_flow ON public.automation_flow_versions USING btree (flow_id, created_at DESC);


--
-- Name: idx_inbound_queues_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_inbound_queues_user ON public.inbound_queues USING btree (user_id);


--
-- Name: idx_integrations_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_integrations_category ON public.integrations USING btree (user_id, category);


--
-- Name: idx_integrations_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_integrations_user ON public.integrations USING btree (user_id);


--
-- Name: idx_lists_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_lists_user ON public.lists USING btree (user_id);


--
-- Name: idx_onboarding_progress_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_onboarding_progress_user ON public.onboarding_progress USING btree (user_id);


--
-- Name: idx_outbound_campaigns_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_agent ON public.outbound_campaigns USING btree (agent_id);


--
-- Name: idx_outbound_campaigns_list; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_list ON public.outbound_campaigns USING btree (list_id);


--
-- Name: idx_outbound_campaigns_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_user ON public.outbound_campaigns USING btree (user_id);


--
-- Name: idx_phone_numbers_agent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_phone_numbers_agent ON public.phone_numbers USING btree (agent_id);


--
-- Name: idx_phone_numbers_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_phone_numbers_user ON public.phone_numbers USING btree (user_id);


--
-- Name: idx_suppressed_emails_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_suppressed_emails_email ON public.suppressed_emails USING btree (email);


--
-- Name: idx_team_members_member; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_team_members_member ON public.team_members USING btree (member_user_id);


--
-- Name: idx_team_members_owner; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_team_members_owner ON public.team_members USING btree (owner_id);


--
-- Name: idx_tools_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_tools_user ON public.tools USING btree (user_id);


--
-- Name: idx_unsubscribe_tokens_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_unsubscribe_tokens_token ON public.email_unsubscribe_tokens USING btree (token);


--
-- Name: idx_voice_widgets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX IF NOT EXISTS idx_voice_widgets_user ON public.voice_widgets USING btree (user_id);


--
-- Name: ai_agents ai_agents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ai_agents_updated_at BEFORE UPDATE ON public.ai_agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: automation_flows automation_flows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER automation_flows_updated_at BEFORE UPDATE ON public.automation_flows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: custom_fields custom_fields_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER custom_fields_updated_at BEFORE UPDATE ON public.custom_fields FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: inbound_queues inbound_queues_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER inbound_queues_updated_at BEFORE UPDATE ON public.inbound_queues FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: integrations integrations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integrations_updated_at BEFORE UPDATE ON public.integrations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: onboarding_progress onboarding_progress_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER onboarding_progress_updated_at BEFORE UPDATE ON public.onboarding_progress FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: outbound_campaigns outbound_campaigns_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER outbound_campaigns_updated_at BEFORE UPDATE ON public.outbound_campaigns FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: team_members team_members_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER team_members_updated_at BEFORE UPDATE ON public.team_members FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tools tools_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tools_updated_at BEFORE UPDATE ON public.tools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: voice_widgets voice_widgets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER voice_widgets_updated_at BEFORE UPDATE ON public.voice_widgets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: agent_knowledge agent_knowledge_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_knowledge
    ADD CONSTRAINT agent_knowledge_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE CASCADE;


--
-- Name: agent_knowledge agent_knowledge_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.agent_knowledge
    ADD CONSTRAINT agent_knowledge_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: ai_agents ai_agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agents
    ADD CONSTRAINT ai_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: automation_flow_versions automation_flow_versions_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_flow_versions
    ADD CONSTRAINT automation_flow_versions_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.automation_flows(id) ON DELETE CASCADE;


--
-- Name: automation_flow_versions automation_flow_versions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_flow_versions
    ADD CONSTRAINT automation_flow_versions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: automation_flows automation_flows_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_flows
    ADD CONSTRAINT automation_flows_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: automation_runs automation_runs_flow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_flow_id_fkey FOREIGN KEY (flow_id) REFERENCES public.automation_flows(id) ON DELETE CASCADE;


--
-- Name: automation_runs automation_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_runs
    ADD CONSTRAINT automation_runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: billing billing_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.billing
    ADD CONSTRAINT billing_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: contacts contacts_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE SET NULL;


--
-- Name: contacts contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.contacts
    ADD CONSTRAINT contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_campaign_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES public.outbound_campaigns(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE SET NULL;


--
-- Name: conversations conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: custom_fields custom_fields_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_fields
    ADD CONSTRAINT custom_fields_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: inbound_queues inbound_queues_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_queues
    ADD CONSTRAINT inbound_queues_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: inbound_queues inbound_queues_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_queues
    ADD CONSTRAINT inbound_queues_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_numbers(id) ON DELETE SET NULL;


--
-- Name: inbound_queues inbound_queues_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.inbound_queues
    ADD CONSTRAINT inbound_queues_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: integrations integrations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integrations
    ADD CONSTRAINT integrations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: lists lists_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lists
    ADD CONSTRAINT lists_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: onboarding_progress onboarding_progress_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.onboarding_progress
    ADD CONSTRAINT onboarding_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: outbound_campaigns outbound_campaigns_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_campaigns
    ADD CONSTRAINT outbound_campaigns_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: outbound_campaigns outbound_campaigns_list_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_campaigns
    ADD CONSTRAINT outbound_campaigns_list_id_fkey FOREIGN KEY (list_id) REFERENCES public.lists(id) ON DELETE SET NULL;


--
-- Name: outbound_campaigns outbound_campaigns_phone_number_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_campaigns
    ADD CONSTRAINT outbound_campaigns_phone_number_id_fkey FOREIGN KEY (phone_number_id) REFERENCES public.phone_numbers(id) ON DELETE SET NULL;


--
-- Name: outbound_campaigns outbound_campaigns_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbound_campaigns
    ADD CONSTRAINT outbound_campaigns_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: phone_numbers phone_numbers_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: phone_numbers phone_numbers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.phone_numbers
    ADD CONSTRAINT phone_numbers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: team_members team_members_member_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_member_user_id_fkey FOREIGN KEY (member_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: team_members team_members_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_members
    ADD CONSTRAINT team_members_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: tools tools_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tools
    ADD CONSTRAINT tools_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: voice_widgets voice_widgets_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_widgets
    ADD CONSTRAINT voice_widgets_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.ai_agents(id) ON DELETE SET NULL;


--
-- Name: voice_widgets voice_widgets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_widgets
    ADD CONSTRAINT voice_widgets_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: waitlist Anyone can join the waitlist; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: team_members Members can view their membership; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: team_members Owners manage their team; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_send_log Service role can insert send log; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: suppressed_emails Service role can insert suppressed emails; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_unsubscribe_tokens Service role can insert tokens; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_send_state Service role can manage send state; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_unsubscribe_tokens Service role can mark tokens as used; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_send_log Service role can read send log; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: suppressed_emails Service role can read suppressed emails; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_unsubscribe_tokens Service role can read tokens; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: email_send_log Service role can update send log; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: billing Service role full access; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: ai_agents Users can delete own ai_agents; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_flows Users can delete own automation_flows; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: contacts Users can delete own contacts; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: conversations Users can delete own conversations; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: lists Users can delete own lists; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: phone_numbers Users can delete own phone_numbers; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: tools Users can delete own tools; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: ai_agents Users can insert own ai_agents; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_flows Users can insert own automation_flows; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: contacts Users can insert own contacts; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: conversations Users can insert own conversations; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: lists Users can insert own lists; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: phone_numbers Users can insert own phone_numbers; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: profiles Users can insert own profile; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: tools Users can insert own tools; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: billing Users can read own billing; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: profiles Users can read own profile; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: ai_agents Users can update own ai_agents; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_flows Users can update own automation_flows; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: contacts Users can update own contacts; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: conversations Users can update own conversations; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: lists Users can update own lists; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: phone_numbers Users can update own phone_numbers; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: tools Users can update own tools; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: ai_agents Users can view own ai_agents; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_flows Users can view own automation_flows; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: contacts Users can view own contacts; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: conversations Users can view own conversations; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: lists Users can view own lists; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: phone_numbers Users can view own phone_numbers; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: tools Users can view own tools; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: agent_knowledge Users manage own agent_knowledge; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_runs Users manage own automation_runs; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: custom_fields Users manage own custom_fields; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: automation_flow_versions Users manage own flow_versions; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: inbound_queues Users manage own inbound_queues; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: integrations Users manage own integrations; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: onboarding_progress Users manage own onboarding_progress; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: outbound_campaigns Users manage own outbound_campaigns; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: voice_widgets Users manage own voice_widgets; Type: POLICY; Schema: public; Owner: -
--

--
-- Name: agent_knowledge; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: ai_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: automation_flow_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: automation_flows; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: automation_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: billing; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: custom_fields; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: email_send_log; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: email_send_state; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: email_unsubscribe_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: inbound_queues; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: integrations; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: lists; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: onboarding_progress; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: outbound_campaigns; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: phone_numbers; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: suppressed_emails; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: team_members; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: tools; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: voice_widgets; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- Name: waitlist; Type: ROW SECURITY; Schema: public; Owner: -
--

--
-- PostgreSQL database dump complete
--

