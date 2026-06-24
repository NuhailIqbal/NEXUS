-- Add full tool configuration columns so custom tools persist their API config
ALTER TABLE tools ADD COLUMN IF NOT EXISTS url TEXT;
ALTER TABLE tools ADD COLUMN IF NOT EXISTS method TEXT DEFAULT 'POST';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS headers JSONB DEFAULT '{}';
ALTER TABLE tools ADD COLUMN IF NOT EXISTS parameters JSONB DEFAULT '[]';
