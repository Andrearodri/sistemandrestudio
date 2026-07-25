ALTER TABLE evidence_acquisition_runs
  ADD COLUMN external_idempotency_key text,
  ADD COLUMN identity_mode text,
  ADD COLUMN identity_version text,
  ADD COLUMN content_identity_hash text;

UPDATE evidence_acquisition_runs
SET external_idempotency_key = idempotency_key,
    identity_mode = 'EXPLICIT',
    identity_version = 'legacy-explicit-identity-v0',
    content_identity_hash = command_fingerprint;

ALTER TABLE evidence_acquisition_runs
  ALTER COLUMN external_idempotency_key SET NOT NULL,
  ALTER COLUMN identity_mode SET NOT NULL,
  ALTER COLUMN identity_version SET NOT NULL,
  ALTER COLUMN content_identity_hash SET NOT NULL,
  ADD CONSTRAINT evidence_acquisition_identity_mode_check
    CHECK (identity_mode IN ('EXPLICIT', 'CONTENT_VERSIONED')),
  ADD CONSTRAINT evidence_acquisition_content_hash_check
    CHECK (content_identity_hash ~ '^[0-9a-f]{64}$');

CREATE INDEX evidence_acquisition_external_key_idx
  ON evidence_acquisition_runs(
    source_item_id,
    external_idempotency_key,
    finished_at DESC,
    id DESC
  );

CREATE INDEX evidence_acquisition_content_identity_idx
  ON evidence_acquisition_runs(
    source_item_id,
    content_identity_hash,
    policy_version,
    source_policy_version
  );
