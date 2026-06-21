-- Agent wizard fields: persist data previously discarded by the Create AI Agent flow.
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS main_goal TEXT;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS website TEXT;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS selected_tool_keys TEXT[] NOT NULL DEFAULT '{}';
