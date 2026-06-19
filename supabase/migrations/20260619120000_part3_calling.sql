-- Part 3: Add VAPI linkage columns for telephony
ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS vapi_phone_id TEXT;
ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'vapi';
ALTER TABLE public.phone_numbers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE public.outbound_campaigns ADD COLUMN IF NOT EXISTS vapi_campaign_id TEXT;
ALTER TABLE public.outbound_campaigns ADD COLUMN IF NOT EXISTS phone_number_id UUID REFERENCES public.phone_numbers(id) ON DELETE SET NULL;

ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS direction TEXT DEFAULT 'outbound' CHECK (direction IN ('inbound', 'outbound'));
