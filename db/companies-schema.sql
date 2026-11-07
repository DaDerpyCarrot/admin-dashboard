-- Additive schema for website-only Companies. Run inside a transaction.
CREATE TABLE IF NOT EXISTS road_companies (
  id UUID PRIMARY KEY,
  title_id VARCHAR(32) NOT NULL CHECK (title_id ~ '^[A-Z0-9]{1,32}$'),
  name VARCHAR(60) NOT NULL CHECK (char_length(btrim(name)) BETWEEN 3 AND 60),
  moderator_id VARCHAR(64) NOT NULL CHECK (moderator_id ~ '^[A-F0-9]{3,64}$'),
  moderator_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS road_companies_moderator
  ON road_companies (title_id, moderator_id, id);

-- The creator is stored only in road_companies; these are regular members.
CREATE TABLE IF NOT EXISTS road_company_members (
  company_id UUID NOT NULL REFERENCES road_companies(id) ON DELETE CASCADE,
  player_id VARCHAR(64) NOT NULL CHECK (player_id ~ '^[A-F0-9]{3,64}$'),
  display_name VARCHAR(100) NOT NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, player_id)
);
CREATE INDEX IF NOT EXISTS road_company_members_player
  ON road_company_members (player_id, company_id);

-- Pending invitations only. A response or revocation removes the row.
CREATE TABLE IF NOT EXISTS road_company_invites (
  id UUID PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES road_companies(id) ON DELETE CASCADE,
  player_id VARCHAR(64) NOT NULL CHECK (player_id ~ '^[A-F0-9]{3,64}$'),
  display_name VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  UNIQUE (company_id, player_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS road_company_invites_player
  ON road_company_invites (player_id, id);
