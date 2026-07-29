ALTER TABLE editorial_news
  DROP CONSTRAINT editorial_news_state_check;

ALTER TABLE editorial_news
  ADD CONSTRAINT editorial_news_state_check CHECK (
    state IN (
      'RECEIVED',
      'NORMALIZED',
      'DUPLICATE',
      'SCORED',
      'DISCARDED_LOW_RELEVANCE',
      'PENDING_VERIFICATION',
      'VERIFIED',
      'VERIFICATION_REJECTED',
      'DRAFT_CREATED',
      'PENDING_APPROVAL',
      'CHANGES_REQUESTED',
      'APPROVED',
      'REJECTED',
      'READY_FOR_PUBLICATION',
      'PUBLISHED'
    )
  );

ALTER TABLE publication_packages
  DROP CONSTRAINT publication_packages_status_check;

ALTER TABLE publication_packages
  ADD CONSTRAINT publication_packages_status_check CHECK (
    status IN (
      'CREATED',
      'VALIDATED',
      'EXPORTED',
      'READY_FOR_PUBLICATION',
      'PUBLISHED',
      'FAILED'
    )
  );

CREATE TABLE publication_reconciliations (
  id text PRIMARY KEY,
  publication_id text NOT NULL UNIQUE
    REFERENCES publication_packages(id) ON DELETE RESTRICT,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  draft_id text NOT NULL REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  destination text NOT NULL CHECK (destination = 'WEBSITE'),
  execution_origin text NOT NULL CHECK (
    execution_origin IN (
      'SYSTEM_EXECUTED',
      'MANUAL_SUPERVISED_DEPLOY',
      'EXTERNAL_CONFIRMED'
    )
  ),
  operator_id text NOT NULL CHECK (char_length(operator_id) BETWEEN 3 AND 80),
  confirmed_at timestamptz NOT NULL,
  public_url text NOT NULL CHECK (public_url ~ '^https://'),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  website_commit text CHECK (
    website_commit IS NULL OR website_commit ~ '^[0-9a-fA-F]{7,40}$'
  ),
  deployment_target_label text CHECK (
    deployment_target_label IS NULL OR
    char_length(deployment_target_label) BETWEEN 1 AND 120
  ),
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  verification_status text NOT NULL CHECK (
    verification_status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS', 'FAILED')
  ),
  reconciliation_status text NOT NULL CHECK (
    reconciliation_status IN ('COMPLETED', 'FAILED')
  ),
  functional_fingerprint text NOT NULL UNIQUE CHECK (
    char_length(functional_fingerprint) = 64
  ),
  previous_state text NOT NULL CHECK (previous_state = 'READY_FOR_PUBLICATION'),
  final_state text NOT NULL CHECK (final_state = 'PUBLISHED'),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  idempotency_key text NOT NULL UNIQUE,
  command_id text NOT NULL,
  created_at timestamptz NOT NULL,
  CHECK (
    reconciliation_status <> 'COMPLETED' OR
    verification_status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS')
  )
);

CREATE TABLE publication_public_verifications (
  id text PRIMARY KEY,
  reconciliation_id text NOT NULL UNIQUE
    REFERENCES publication_reconciliations(id) ON DELETE RESTRICT,
  publication_id text NOT NULL REFERENCES publication_packages(id)
    ON DELETE RESTRICT,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  status text NOT NULL CHECK (
    status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS', 'FAILED')
  ),
  http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
  final_url text NOT NULL CHECK (final_url ~ '^https://'),
  canonical_url text NOT NULL CHECK (canonical_url ~ '^https://'),
  content_fingerprint text NOT NULL CHECK (
    char_length(content_fingerprint) = 64
  ),
  warnings jsonb NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  CHECK (completed_at >= started_at)
);

CREATE TABLE publication_verification_checks (
  verification_id text NOT NULL REFERENCES publication_public_verifications(id)
    ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  check_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASS', 'WARN', 'FAIL')),
  expected_value text,
  observed_summary text NOT NULL CHECK (
    char_length(observed_summary) BETWEEN 1 AND 500
  ),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (verification_id, position),
  UNIQUE (verification_id, check_code)
);

CREATE INDEX publication_reconciliations_news_idx
  ON publication_reconciliations(news_id, created_at);

CREATE INDEX publication_public_verifications_publication_idx
  ON publication_public_verifications(publication_id, completed_at);

CREATE OR REPLACE FUNCTION enforce_published_reconciliation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'publication_packages'
     AND to_jsonb(NEW)->>'status' = 'PUBLISHED' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM publication_reconciliations r
      JOIN publication_public_verifications v
        ON v.reconciliation_id = r.id
      WHERE r.publication_id = NEW.id
        AND r.reconciliation_status = 'COMPLETED'
        AND r.verification_status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS')
        AND v.status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS')
    ) THEN
      RAISE EXCEPTION
        'PUBLISHED publication package requires completed public reconciliation';
    END IF;
  ELSIF TG_TABLE_NAME = 'editorial_news'
        AND to_jsonb(NEW)->>'state' = 'PUBLISHED' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM publication_packages p
      JOIN publication_reconciliations r ON r.publication_id = p.id
      JOIN publication_public_verifications v
        ON v.reconciliation_id = r.id
      WHERE p.news_id = NEW.id
        AND p.status = 'PUBLISHED'
        AND r.reconciliation_status = 'COMPLETED'
        AND r.verification_status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS')
        AND v.status IN ('VERIFIED', 'VERIFIED_WITH_WARNINGS')
    ) THEN
      RAISE EXCEPTION
        'PUBLISHED editorial news requires a reconciled publication package';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER publication_package_published_reconciliation
AFTER INSERT OR UPDATE OF status ON publication_packages
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_published_reconciliation();

CREATE CONSTRAINT TRIGGER editorial_news_published_reconciliation
AFTER INSERT OR UPDATE OF state ON editorial_news
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_published_reconciliation();
