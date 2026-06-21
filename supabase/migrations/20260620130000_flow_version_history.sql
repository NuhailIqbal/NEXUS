-- Flow version history: snapshot automation_flows.definition on every update,
-- capped at 10 per flow. Allows users to restore a previous version.

CREATE TABLE IF NOT EXISTS public.automation_flow_versions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flow_id        UUID NOT NULL REFERENCES public.automation_flows(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  definition     JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.automation_flow_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users manage own flow_versions" ON public.automation_flow_versions;
CREATE POLICY "Users manage own flow_versions"
  ON public.automation_flow_versions FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_flow_versions_flow ON public.automation_flow_versions (flow_id, created_at DESC);
