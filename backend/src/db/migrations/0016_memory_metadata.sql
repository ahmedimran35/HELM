-- Memory strategy metadata, including summary source ids.
ALTER TABLE memory_entries
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
