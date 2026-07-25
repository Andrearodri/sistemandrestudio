CREATE TABLE evidence_acquisition_runs (
  id text PRIMARY KEY,
  source_item_id text NOT NULL
    REFERENCES collected_source_items(id) ON DELETE RESTRICT,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  verification_run_id text
    REFERENCES verification_runs(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  command_fingerprint text NOT NULL,
  policy_version text NOT NULL CHECK (
    policy_version = 'official-evidence-acquisition-v1'
  ),
  source_policy_version text NOT NULL CHECK (
    source_policy_version = 'official-page-policy-v1'
  ),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  status text NOT NULL CHECK (
    status IN ('RUNNING', 'SUCCEEDED', 'FAILED')
  ),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  result jsonb,
  error_code text,
  CHECK (
    (status = 'RUNNING' AND finished_at IS NULL)
    OR (status IN ('SUCCEEDED', 'FAILED') AND finished_at IS NOT NULL)
  )
);

CREATE TABLE official_page_fetch_runs (
  id text PRIMARY KEY,
  acquisition_run_id text NOT NULL
    REFERENCES evidence_acquisition_runs(id) ON DELETE RESTRICT,
  source_item_id text NOT NULL
    REFERENCES collected_source_items(id) ON DELETE RESTRICT,
  requested_url text NOT NULL CHECK (requested_url ~ '^https://'),
  final_url text NOT NULL CHECK (final_url ~ '^https://'),
  relationship text NOT NULL CHECK (
    relationship IN (
      'PRIMARY_ARTICLE', 'OFFICIAL_DOCUMENTATION', 'OFFICIAL_CHANGELOG',
      'OFFICIAL_RELEASE', 'OFFICIAL_REPOSITORY',
      'OFFICIAL_SECURITY_ADVISORY'
    )
  ),
  status text NOT NULL CHECK (status IN ('SUCCEEDED', 'FAILED')),
  http_status integer CHECK (http_status BETWEEN 100 AND 599),
  content_type text,
  response_bytes integer CHECK (
    response_bytes IS NULL OR response_bytes BETWEEN 0 AND 1000000
  ),
  redirect_count integer NOT NULL CHECK (redirect_count BETWEEN 0 AND 2),
  content_hash text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  error_code text,
  UNIQUE (acquisition_run_id, requested_url)
);

CREATE TABLE official_page_snapshots (
  id text PRIMARY KEY,
  fetch_run_id text NOT NULL UNIQUE
    REFERENCES official_page_fetch_runs(id) ON DELETE RESTRICT,
  source_item_id text NOT NULL
    REFERENCES collected_source_items(id) ON DELETE RESTRICT,
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  page_type text NOT NULL CHECK (
    page_type IN (
      'OFFICIAL_BLOG_POST', 'OFFICIAL_DOCUMENTATION',
      'OFFICIAL_CHANGELOG', 'OFFICIAL_RELEASE',
      'OFFICIAL_REPOSITORY_RELEASE', 'OFFICIAL_SECURITY_ADVISORY',
      'UNKNOWN_OFFICIAL_PAGE'
    )
  ),
  relationship text NOT NULL,
  title text NOT NULL CHECK (char_length(title) <= 300),
  summary text NOT NULL CHECK (char_length(summary) <= 1500),
  headings jsonb NOT NULL CHECK (octet_length(headings::text) <= 10000),
  minimal_text text NOT NULL CHECK (char_length(minimal_text) <= 6000),
  selected_metadata jsonb NOT NULL CHECK (
    octet_length(selected_metadata::text) <= 20000
  ),
  published_at timestamptz,
  updated_at_source timestamptz,
  content_hash text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  UNIQUE (source_item_id, canonical_url, content_hash)
);

CREATE TABLE official_page_metadata (
  snapshot_id text PRIMARY KEY
    REFERENCES official_page_snapshots(id) ON DELETE RESTRICT,
  canonical_url text,
  author text,
  organization text,
  article_type text,
  version text,
  availability text,
  product text,
  open_graph jsonb NOT NULL CHECK (octet_length(open_graph::text) <= 10000),
  twitter_card jsonb NOT NULL CHECK (
    octet_length(twitter_card::text) <= 10000
  ),
  json_ld jsonb NOT NULL CHECK (octet_length(json_ld::text) <= 30000)
);

CREATE TABLE evidence_candidates (
  id text PRIMARY KEY,
  acquisition_run_id text NOT NULL
    REFERENCES evidence_acquisition_runs(id) ON DELETE RESTRICT,
  snapshot_id text NOT NULL
    REFERENCES official_page_snapshots(id) ON DELETE RESTRICT,
  source_item_id text NOT NULL
    REFERENCES collected_source_items(id) ON DELETE RESTRICT,
  claim_id text NOT NULL
    REFERENCES verification_claims(id) ON DELETE RESTRICT,
  evidence_id text NOT NULL UNIQUE
    REFERENCES verification_evidence(id) ON DELETE RESTRICT,
  authority text NOT NULL CHECK (
    authority IN (
      'PRIMARY_OFFICIAL', 'OFFICIAL_DOCUMENTATION', 'OFFICIAL_CHANGELOG',
      'OFFICIAL_REPOSITORY', 'OFFICIAL_BLOG', 'SECONDARY_REPUTABLE',
      'COMMUNITY', 'UNKNOWN'
    )
  ),
  evidence_type text NOT NULL,
  excerpt text NOT NULL CHECK (char_length(excerpt) <= 500),
  structured_facts jsonb NOT NULL CHECK (
    octet_length(structured_facts::text) <= 10000
  ),
  supports_claim boolean NOT NULL,
  contradicts_claim boolean NOT NULL,
  extraction_method text NOT NULL,
  association_rule text NOT NULL,
  association_confidence integer NOT NULL CHECK (
    association_confidence BETWEEN 0 AND 100
  ),
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (NOT (supports_claim AND contradicts_claim)),
  UNIQUE (acquisition_run_id, claim_id, snapshot_id, association_rule)
);

CREATE INDEX evidence_acquisition_runs_item_idx
  ON evidence_acquisition_runs(source_item_id, started_at, id);

CREATE INDEX official_page_fetch_runs_item_idx
  ON official_page_fetch_runs(source_item_id, started_at, id);

CREATE INDEX official_page_snapshots_item_idx
  ON official_page_snapshots(source_item_id, retrieved_at, id);

CREATE INDEX official_page_snapshots_hash_idx
  ON official_page_snapshots(content_hash);

CREATE INDEX evidence_candidates_item_idx
  ON evidence_candidates(source_item_id, created_at, id);

CREATE INDEX evidence_candidates_claim_idx
  ON evidence_candidates(claim_id, created_at, id);
