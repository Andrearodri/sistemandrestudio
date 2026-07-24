CREATE TABLE source_definitions (
  id text PRIMARY KEY,
  name text NOT NULL,
  organization text NOT NULL,
  feed_url text NOT NULL,
  definition jsonb NOT NULL,
  enabled boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_fetch_runs (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES source_definitions(id),
  mode text NOT NULL CHECK (mode IN ('READ_ONLY_EXTERNAL', 'FIXTURES')),
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  items_found integer NOT NULL DEFAULT 0,
  items_new integer NOT NULL DEFAULT 0,
  items_duplicate integer NOT NULL DEFAULT 0,
  error_code text,
  error_message text
);

CREATE TABLE collected_source_items (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES source_definitions(id),
  external_id text,
  canonical_url text NOT NULL,
  title text NOT NULL,
  summary text,
  published_at timestamptz,
  updated_at_source timestamptz,
  collected_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  editorial_news_id text REFERENCES editorial_news(id),
  similarity_score numeric,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_id, canonical_url),
  UNIQUE (source_id, content_hash)
);
CREATE UNIQUE INDEX collected_source_items_external_id_unique
  ON collected_source_items (source_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE source_item_duplicates (
  id text PRIMARY KEY,
  source_id text NOT NULL REFERENCES source_definitions(id),
  incoming_external_id text,
  incoming_canonical_url text NOT NULL,
  incoming_content_hash text NOT NULL,
  canonical_item_id text NOT NULL REFERENCES collected_source_items(id),
  match_type text NOT NULL CHECK (match_type IN ('CANONICAL_URL', 'EXTERNAL_ID', 'CONTENT_HASH')),
  detected_at timestamptz NOT NULL,
  UNIQUE (source_id, incoming_content_hash, match_type)
);
