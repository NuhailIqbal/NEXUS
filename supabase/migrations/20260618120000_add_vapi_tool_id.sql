-- Add VAPI linkage columns for tools and agent_knowledge
ALTER TABLE public.tools ADD COLUMN IF NOT EXISTS vapi_tool_id TEXT;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS system_prompt TEXT;
ALTER TABLE public.ai_agents ADD COLUMN IF NOT EXISTS first_message TEXT;
