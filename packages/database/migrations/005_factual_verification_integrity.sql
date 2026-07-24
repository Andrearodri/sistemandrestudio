-- 004 was already applied locally; this incremental migration completes its
-- integrity model without rewriting an applied checksum.
ALTER TABLE verification_runs
  ADD COLUMN command_fingerprint text,
  ADD COLUMN expected_version integer,
  ADD COLUMN previous_state text,
  ADD COLUMN current_state text;

UPDATE verification_runs
SET command_fingerprint = md5(idempotency_key || ':' || id),
    expected_version = 0,
    previous_state = 'PENDING_VERIFICATION',
    current_state = 'PENDING_VERIFICATION'
WHERE command_fingerprint IS NULL;

ALTER TABLE verification_runs
  ALTER COLUMN command_fingerprint SET NOT NULL,
  ALTER COLUMN expected_version SET NOT NULL,
  ALTER COLUMN previous_state SET NOT NULL,
  ALTER COLUMN current_state SET NOT NULL,
  ADD CONSTRAINT verification_runs_status_check
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
  ADD CONSTRAINT verification_runs_expected_version_check
    CHECK (expected_version >= 0),
  ADD CONSTRAINT verification_runs_policy_check
    CHECK (
      policy_id = 'andre-studio-verification'
      AND policy_version = 'andre-studio-verification-v1'
    ),
  ADD CONSTRAINT verification_runs_finished_check
    CHECK (
      (status = 'RUNNING' AND finished_at IS NULL)
      OR (status IN ('SUCCEEDED', 'FAILED') AND finished_at IS NOT NULL)
    );

ALTER TABLE verification_claims
  ADD COLUMN run_id text REFERENCES verification_runs(id) ON DELETE RESTRICT,
  ADD COLUMN ordinal integer;

UPDATE verification_claims claim
SET run_id = (
      SELECT run.id
      FROM verification_runs run
      WHERE run.news_id = claim.news_id
      ORDER BY run.started_at, run.id
      LIMIT 1
    ),
    ordinal = 0
WHERE run_id IS NULL;

ALTER TABLE verification_claims
  ALTER COLUMN run_id SET NOT NULL,
  ALTER COLUMN ordinal SET NOT NULL,
  ADD CONSTRAINT verification_claims_type_check
    CHECK (claim_type IN (
      'PRODUCT_LAUNCH', 'MODEL_RELEASE', 'FEATURE_RELEASE', 'API_CHANGE',
      'VERSION_RELEASE', 'PRICE_CHANGE', 'DEPRECATION', 'SECURITY_ADVISORY',
      'POLICY_CHANGE', 'DATE_CLAIM', 'AVAILABILITY_CLAIM',
      'PERFORMANCE_CLAIM', 'GENERAL_FACT'
    )),
  ADD CONSTRAINT verification_claims_text_check
    CHECK (length(btrim(claim_text)) BETWEEN 1 AND 2000),
  ADD CONSTRAINT verification_claims_ordinal_check CHECK (ordinal >= 0),
  ADD CONSTRAINT verification_claims_run_order_unique UNIQUE (run_id, ordinal);

ALTER TABLE verification_evidence
  ADD COLUMN ordinal integer,
  ADD COLUMN updated_at timestamptz,
  ADD COLUMN superseded_at timestamptz,
  ADD COLUMN available_at timestamptz;

UPDATE verification_evidence SET ordinal = 0 WHERE ordinal IS NULL;

ALTER TABLE verification_evidence
  ALTER COLUMN ordinal SET NOT NULL,
  ADD CONSTRAINT verification_evidence_authority_check
    CHECK (authority IN (
      'PRIMARY_OFFICIAL', 'OFFICIAL_DOCUMENTATION', 'OFFICIAL_CHANGELOG',
      'OFFICIAL_REPOSITORY', 'OFFICIAL_BLOG', 'SECONDARY_REPUTABLE',
      'COMMUNITY', 'UNKNOWN'
    )),
  ADD CONSTRAINT verification_evidence_type_check
    CHECK (evidence_type IN (
      'RELEASE_NOTE', 'DOCUMENTATION', 'CHANGELOG', 'BLOG_ANNOUNCEMENT',
      'REPOSITORY_RELEASE', 'SECURITY_ADVISORY', 'STRUCTURED_METADATA',
      'DATE_RECORD', 'OTHER'
    )),
  ADD CONSTRAINT verification_evidence_https_check
    CHECK (canonical_url ~ '^https://'),
  ADD CONSTRAINT verification_evidence_assessment_check
    CHECK (NOT (supports_claim AND contradicts_claim)),
  ADD CONSTRAINT verification_evidence_facts_size_check
    CHECK (octet_length(structured_facts::text) <= 10000),
  ADD CONSTRAINT verification_evidence_ordinal_check CHECK (ordinal >= 0),
  ADD CONSTRAINT verification_evidence_claim_order_unique
    UNIQUE (claim_id, ordinal);

ALTER TABLE verification_results
  ADD CONSTRAINT verification_results_status_check
    CHECK (status IN (
      'CONFIRMED', 'PARTIALLY_CONFIRMED', 'UNCONFIRMED',
      'CONTRADICTED', 'OUTDATED', 'INSUFFICIENT_EVIDENCE'
    )),
  ADD CONSTRAINT verification_results_decision_check
    CHECK (editorial_decision IN (
      'ALLOW_DRAFT_GENERATION', 'REQUIRE_HUMAN_REVIEW',
      'BLOCK_UNCONFIRMED', 'BLOCK_CONTRADICTED', 'BLOCK_OUTDATED',
      'BLOCK_INSUFFICIENT_EVIDENCE'
    )),
  ADD CONSTRAINT verification_results_status_decision_check
    CHECK (
      (status = 'CONFIRMED' AND editorial_decision = 'ALLOW_DRAFT_GENERATION')
      OR (
        status = 'PARTIALLY_CONFIRMED'
        AND editorial_decision = 'REQUIRE_HUMAN_REVIEW'
      )
      OR (
        status = 'UNCONFIRMED'
        AND editorial_decision = 'BLOCK_UNCONFIRMED'
      )
      OR (
        status = 'CONTRADICTED'
        AND editorial_decision = 'BLOCK_CONTRADICTED'
      )
      OR (status = 'OUTDATED' AND editorial_decision = 'BLOCK_OUTDATED')
      OR (
        status = 'INSUFFICIENT_EVIDENCE'
        AND editorial_decision = 'BLOCK_INSUFFICIENT_EVIDENCE'
      )
    ),
  ADD CONSTRAINT verification_results_status_confidence_check
    CHECK (
      (status = 'CONFIRMED' AND confidence >= 75)
      OR (status = 'PARTIALLY_CONFIRMED' AND confidence BETWEEN 1 AND 99)
      OR (status = 'UNCONFIRMED' AND confidence < 75)
      OR (status = 'CONTRADICTED' AND confidence = 0)
      OR status = 'OUTDATED'
      OR (status = 'INSUFFICIENT_EVIDENCE' AND confidence <= 25)
    );

ALTER TABLE verification_claim_results
  ADD CONSTRAINT verification_claim_results_status_check
    CHECK (status IN (
      'SUPPORTED', 'PARTIALLY_SUPPORTED', 'UNSUPPORTED',
      'CONTRADICTED', 'OUTDATED'
    ));

CREATE INDEX verification_runs_news_started_idx
  ON verification_runs(news_id, started_at, id);

CREATE INDEX verification_claims_run_idx
  ON verification_claims(run_id, ordinal);

CREATE INDEX verification_results_news_evaluated_idx
  ON verification_results(news_id, evaluated_at, id);
