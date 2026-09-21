CREATE TABLE identities (
  id uuid PRIMARY KEY,
  token_hash text UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 days'
);
CREATE TABLE usage_buckets (
  scope text NOT NULL, day date NOT NULL DEFAULT CURRENT_DATE,
  calls integer NOT NULL CHECK (calls >= 0), PRIMARY KEY (scope, day)
);
CREATE TABLE episodes (
  id text PRIMARY KEY, title text NOT NULL, show_title text NOT NULL, description text NOT NULL,
  audio_version text NOT NULL, duration_seconds double precision NOT NULL CHECK(duration_seconds > 0),
  status text NOT NULL CHECK(status IN ('queued', 'processing', 'ready', 'failed')),
  audio_key text, transcript_key text, prepared_at timestamptz
);
CREATE TABLE transcript_segments (
  episode_id text NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  audio_version text NOT NULL, id text NOT NULL, start_seconds double precision NOT NULL,
  end_seconds double precision NOT NULL, text text NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  PRIMARY KEY (episode_id, audio_version, id), CHECK(start_seconds >= 0 AND end_seconds > start_seconds)
);
CREATE INDEX transcript_search ON transcript_segments USING gin(search);
CREATE TABLE listening_sessions (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES identities(id) ON DELETE CASCADE,
  episode_id text NOT NULL REFERENCES episodes(id), audio_version text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  position_seconds double precision NOT NULL DEFAULT 0 CHECK(position_seconds >= 0),
  bookmark_seconds double precision CHECK(bookmark_seconds >= 0),
  phase text NOT NULL DEFAULT 'paused', pending_action jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(owner_id, episode_id)
);
CREATE TABLE conversation_turns (
  session_id uuid NOT NULL REFERENCES listening_sessions(id) ON DELETE CASCADE,
  request_id uuid NOT NULL, request_hash text NOT NULL, question text NOT NULL,
  status text NOT NULL CHECK(status IN ('processing', 'complete', 'failed', 'cancelled')),
  result jsonb, error_code text, speech_status text NOT NULL DEFAULT 'none', speech_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, request_id)
);
CREATE TABLE voice_tickets (
  token_hash text PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES listening_sessions(id) ON DELETE CASCADE,
  revision integer NOT NULL, expires_at timestamptz NOT NULL
);
