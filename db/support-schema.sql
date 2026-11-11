-- Additive, website-only Support Desk. Run inside a transaction.
CREATE TABLE IF NOT EXISTS road_support_tickets (
  id UUID PRIMARY KEY,
  ticket_no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  title_id VARCHAR(32) NOT NULL CHECK (title_id ~ '^[A-F0-9]{1,32}$'),
  player_id VARCHAR(64) NOT NULL CHECK (player_id ~ '^[A-F0-9]{3,64}$'),
  player_name VARCHAR(100) NOT NULL,
  request_id UUID NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  category TEXT NOT NULL CHECK (category IN ('bug','suggestion','account_help','other')),
  area TEXT NOT NULL CHECK (area IN ('game','website','account','general')),
  subject VARCHAR(120) NOT NULL CHECK (char_length(btrim(subject)) BETWEEN 3 AND 120),
  description TEXT NOT NULL CHECK (char_length(btrim(description)) BETWEEN 10 AND 5000),
  steps TEXT NOT NULL DEFAULT '' CHECK (char_length(steps) <= 2000),
  expected TEXT NOT NULL DEFAULT '' CHECK (char_length(expected) <= 2000),
  actual TEXT NOT NULL DEFAULT '' CHECK (char_length(actual) <= 2000),
  game_version VARCHAR(40) NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_review','needs_reply','resolved')),
  assigned_admin VARCHAR(128),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  public_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title_id, player_id, request_id)
);
CREATE INDEX IF NOT EXISTS road_support_player_list ON road_support_tickets (title_id, player_id, ticket_no DESC);
CREATE INDEX IF NOT EXISTS road_support_admin_list ON road_support_tickets (title_id, status, ticket_no DESC);
CREATE INDEX IF NOT EXISTS road_support_submit_quota ON road_support_tickets (title_id, player_id, created_at DESC);

CREATE TABLE IF NOT EXISTS road_support_entries (
  id UUID PRIMARY KEY,
  entry_no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  ticket_id UUID NOT NULL REFERENCES road_support_tickets(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','internal')),
  author_role TEXT NOT NULL CHECK (author_role IN ('player','admin')),
  author_id VARCHAR(128) NOT NULL,
  author_name VARCHAR(100) NOT NULL,
  body TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 5000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (visibility = 'public' OR author_role = 'admin')
);
CREATE INDEX IF NOT EXISTS road_support_thread ON road_support_entries (ticket_id, visibility, entry_no);
CREATE INDEX IF NOT EXISTS road_support_reply_quota ON road_support_entries (author_role, author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS road_support_activity (
  id UUID PRIMARY KEY,
  event_no BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  ticket_id UUID NOT NULL REFERENCES road_support_tickets(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('player','admin')),
  actor_id VARCHAR(128) NOT NULL,
  actor_name VARCHAR(100) NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','player_reply','admin_reply','internal_note','updated')),
  request_id UUID NOT NULL,
  payload_hash CHAR(64) NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
  entry_id UUID REFERENCES road_support_entries(id),
  changes JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, actor_role, actor_id, request_id)
);
CREATE INDEX IF NOT EXISTS road_support_audit ON road_support_activity (ticket_id, event_no);
