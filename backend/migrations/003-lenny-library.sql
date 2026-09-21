ALTER TABLE episodes ADD COLUMN collection text NOT NULL DEFAULT 'fixture';
ALTER TABLE episodes ADD COLUMN guest text;
ALTER TABLE episodes ADD COLUMN published_at date;
ALTER TABLE episodes ADD COLUMN source_url text;
ALTER TABLE episodes ADD COLUMN artwork_url text;
ALTER TABLE episodes ADD COLUMN audio_url text;
ALTER TABLE episodes ADD COLUMN chapters jsonb NOT NULL DEFAULT '[]';
ALTER TABLE episodes ADD COLUMN ad_breaks jsonb NOT NULL DEFAULT '[]';
CREATE TABLE listening_voice_tickets (
  token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
