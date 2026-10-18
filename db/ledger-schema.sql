-- Additive schema. Does not delete/change existing application tables.
CREATE TABLE IF NOT EXISTS road_purchase_transactions (
  id BIGSERIAL PRIMARY KEY,
  title_id VARCHAR(32) NOT NULL,
  player_id VARCHAR(64) NOT NULL,
  purchase_id VARCHAR(128) NOT NULL,
  item_id VARCHAR(256) NOT NULL,
  catalog_version VARCHAR(128) NOT NULL,
  currency_code VARCHAR(8) NOT NULL,
  unit_price BIGINT NOT NULL CHECK (unit_price >= 0),
  quantity BIGINT NOT NULL CHECK (quantity > 0),
  total_price NUMERIC(30,0) NOT NULL CHECK (total_price >= 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  original_timestamp TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title_id, player_id, purchase_id, item_id, catalog_version, currency_code)
);
CREATE INDEX IF NOT EXISTS road_purchase_player_date
  ON road_purchase_transactions (title_id, player_id, occurred_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS road_purchase_events (
  title_id VARCHAR(32) NOT NULL,
  event_id VARCHAR(32) NOT NULL,
  transaction_id BIGINT NOT NULL REFERENCES road_purchase_transactions(id),
  fingerprint VARCHAR(64) NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (title_id, event_id)
);
