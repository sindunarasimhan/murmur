ALTER TABLE listening_sessions ADD COLUMN conversation_context jsonb;
CREATE TABLE catalog_conversations (
  owner_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  episode_id text,
  revision integer NOT NULL DEFAULT 0,
  context jsonb NOT NULL,
  discovery jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,id)
);
