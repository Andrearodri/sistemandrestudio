CREATE TABLE editorial_briefs (
  id text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  verification_id text NOT NULL REFERENCES verification_results(id) ON DELETE RESTRICT,
  relevance_score smallint NOT NULL CHECK (relevance_score BETWEEN 0 AND 100),
  relevance_priority text NOT NULL,
  verification_status text NOT NULL,
  eligibility text NOT NULL CHECK (eligibility IN ('ALLOW_DRAFT', 'ALLOW_RESTRICTED_DRAFT', 'BLOCK_DRAFT')),
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  subject jsonb NOT NULL,
  warnings jsonb NOT NULL,
  prohibited_statements jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (news_id, verification_id, policy_id, policy_version)
);

CREATE TABLE editorial_brief_claims (
  brief_id text NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
  claim_id text NOT NULL REFERENCES verification_claims(id) ON DELETE RESTRICT,
  classification text NOT NULL CHECK (classification IN ('CONFIRMED_AND_ALLOWED', 'CONFIRMED_WITH_LIMITATIONS', 'REQUIRES_HUMAN_REVIEW', 'PROHIBITED')),
  factual_status text NOT NULL,
  confidence smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  evidence_ids jsonb NOT NULL,
  reason text NOT NULL,
  PRIMARY KEY (brief_id, claim_id)
);

CREATE TABLE editorial_brief_facts (
  id text PRIMARY KEY,
  brief_id text NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
  claim_id text NOT NULL REFERENCES verification_claims(id) ON DELETE RESTRICT,
  statement text NOT NULL CHECK (char_length(statement) BETWEEN 1 AND 500),
  confidence smallint NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  restrictions jsonb NOT NULL,
  evidence_ids jsonb NOT NULL
);

CREATE TABLE editorial_drafts (
  id text PRIMARY KEY REFERENCES draft_versions(id) ON DELETE RESTRICT,
  brief_id text NOT NULL REFERENCES editorial_briefs(id) ON DELETE RESTRICT,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE,
  command_fingerprint text NOT NULL,
  format text NOT NULL CHECK (format IN ('LINKEDIN_SHORT_POST', 'WEBSITE_NEWS_BRIEF')),
  language text NOT NULL CHECK (language = 'pt-BR'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  subtitle text,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 3000),
  generator_id text NOT NULL,
  generator_version text NOT NULL,
  validation_status text NOT NULL CHECK (validation_status IN ('VALID', 'VALID_WITH_WARNINGS', 'BLOCKED')),
  created_at timestamptz NOT NULL,
  UNIQUE (brief_id, format, generator_id, generator_version)
);

CREATE TABLE editorial_draft_citations (
  draft_id text NOT NULL REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  evidence_id text NOT NULL REFERENCES verification_evidence(id) ON DELETE RESTRICT,
  claim_id text NOT NULL REFERENCES verification_claims(id) ON DELETE RESTRICT,
  source_id text NOT NULL,
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  page_title text NOT NULL,
  published_at timestamptz,
  PRIMARY KEY (draft_id, evidence_id)
);

CREATE TABLE editorial_draft_validations (
  draft_id text PRIMARY KEY REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('VALID', 'VALID_WITH_WARNINGS', 'BLOCKED')),
  evaluated_rules jsonb NOT NULL,
  warnings jsonb NOT NULL,
  blocking_reasons jsonb NOT NULL,
  validated_at timestamptz NOT NULL
);

CREATE INDEX editorial_briefs_news_idx ON editorial_briefs(news_id, created_at);
CREATE INDEX editorial_drafts_news_idx ON editorial_drafts(news_id, created_at);
