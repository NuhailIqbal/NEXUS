-- Add phone_number_id column to inbound_queues so each receptionist links to a phone number
ALTER TABLE inbound_queues ADD COLUMN IF NOT EXISTS phone_number_id UUID REFERENCES phone_numbers(id) ON DELETE SET NULL;
