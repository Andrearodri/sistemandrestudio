CREATE TABLE editorial_orchestration_runs (
  id text PRIMARY KEY,
  policy_id text NOT NULL,
  policy_version text NOT NULL,
  trigger_type text NOT NULL CHECK (
    trigger_type IN ('MANUAL', 'N8N_SCHEDULED', 'N8N_RETRY')
  ),
  trigger_key text NOT NULL UNIQUE CHECK (
    char_length(trigger_key) BETWEEN 3 AND 160
  ),
  triggered_by text NOT NULL CHECK (
    char_length(triggered_by) BETWEEN 3 AND 160
  ),
  status text NOT NULL CHECK (
    status IN (
      'CREATED',
      'RUNNING',
      'WAITING_HUMAN_DECISION',
      'COMPLETED',
      'COMPLETED_WITH_WARNINGS',
      'FAILED',
      'CANCELLED'
    )
  ),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  functional_fingerprint text NOT NULL UNIQUE CHECK (
    char_length(functional_fingerprint) = 64
  ),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE editorial_orchestration_steps (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES editorial_orchestration_runs(id)
    ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 7),
  step_type text NOT NULL CHECK (
    step_type IN (
      'RADAR_INGESTION',
      'RELEVANCE_EVALUATION',
      'EVIDENCE_ACQUISITION',
      'FACTUAL_VERIFICATION',
      'DRAFT_GENERATION',
      'HUMAN_REVIEW_NOTIFICATION',
      'HUMAN_DECISION',
      'PUBLICATION_PACKAGE_PREPARATION'
    )
  ),
  status text NOT NULL CHECK (
    status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND 3
  ),
  input_reference jsonb CHECK (
    input_reference IS NULL OR (
      jsonb_typeof(input_reference) = 'object' AND
      octet_length(input_reference::text) <= 16000
    )
  ),
  output_reference jsonb CHECK (
    output_reference IS NULL OR (
      jsonb_typeof(output_reference) = 'object' AND
      octet_length(output_reference::text) <= 16000
    )
  ),
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object' AND
    octet_length(metadata::text) <= 8000
  ),
  UNIQUE (run_id, position),
  UNIQUE (run_id, step_type),
  CHECK (completed_at IS NULL OR started_at IS NULL OR completed_at >= started_at),
  CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
);

CREATE TABLE editorial_human_decision_requests (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES editorial_orchestration_runs(id)
    ON DELETE RESTRICT,
  draft_id text NOT NULL,
  draft_version integer NOT NULL CHECK (draft_version > 0),
  news_version integer NOT NULL CHECK (news_version >= 0),
  channel text NOT NULL CHECK (channel IN ('CONSOLE', 'TELEGRAM')),
  recipient_reference text NOT NULL CHECK (
    char_length(recipient_reference) BETWEEN 3 AND 160
  ),
  status text NOT NULL CHECK (
    status IN ('PENDING', 'DELIVERED', 'DECIDED', 'EXPIRED', 'CANCELLED')
  ),
  expires_at timestamptz NOT NULL,
  functional_fingerprint text NOT NULL UNIQUE CHECK (
    char_length(functional_fingerprint) = 64
  ),
  context jsonb NOT NULL CHECK (
    jsonb_typeof(context) = 'object' AND
    octet_length(context::text) <= 16000
  ),
  created_at timestamptz NOT NULL,
  delivered_at timestamptz,
  UNIQUE (run_id, draft_id, draft_version),
  UNIQUE (draft_id, draft_version),
  CHECK (expires_at > created_at),
  CHECK (delivered_at IS NULL OR delivered_at >= created_at)
);

CREATE TABLE editorial_human_decisions (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE
    REFERENCES editorial_human_decision_requests(id) ON DELETE RESTRICT,
  reviewer_id text NOT NULL CHECK (
    char_length(reviewer_id) BETWEEN 3 AND 160
  ),
  decision text NOT NULL CHECK (
    decision IN ('APPROVE', 'REJECT', 'REQUEST_CHANGES')
  ),
  reason text CHECK (
    reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000
  ),
  change_instructions jsonb CHECK (
    change_instructions IS NULL OR (
      jsonb_typeof(change_instructions) = 'array' AND
      octet_length(change_instructions::text) <= 8000
    )
  ),
  received_at timestamptz NOT NULL,
  external_message_reference text CHECK (
    external_message_reference IS NULL OR
    char_length(external_message_reference) BETWEEN 3 AND 160
  ),
  functional_fingerprint text NOT NULL UNIQUE CHECK (
    char_length(functional_fingerprint) = 64
  ),
  CHECK (decision <> 'REJECT' OR reason IS NOT NULL),
  CHECK (
    decision <> 'REQUEST_CHANGES' OR
    jsonb_array_length(change_instructions) > 0
  )
);

CREATE TABLE editorial_orchestration_attempts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES editorial_orchestration_runs(id)
    ON DELETE RESTRICT,
  step_id text NOT NULL REFERENCES editorial_orchestration_steps(id)
    ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED')),
  error_code text,
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  UNIQUE (step_id, attempt_number),
  CHECK (completed_at IS NULL OR completed_at >= started_at),
  CHECK (status <> 'FAILED' OR error_code IS NOT NULL)
);

CREATE TABLE editorial_orchestration_events (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES editorial_orchestration_runs(id)
    ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (
    event_type IN (
      'EDITORIAL_ORCHESTRATION_STARTED',
      'EDITORIAL_ORCHESTRATION_STEP_STARTED',
      'EDITORIAL_ORCHESTRATION_STEP_COMPLETED',
      'EDITORIAL_ORCHESTRATION_WAITING_HUMAN',
      'HUMAN_DECISION_REQUESTED',
      'HUMAN_DECISION_DELIVERED',
      'HUMAN_DECISION_RECEIVED',
      'EDITORIAL_ORCHESTRATION_RESUMED',
      'EDITORIAL_ORCHESTRATION_COMPLETED',
      'EDITORIAL_ORCHESTRATION_FAILED',
      'EDITORIAL_ORCHESTRATION_REPLAYED'
    )
  ),
  step_id text REFERENCES editorial_orchestration_steps(id) ON DELETE RESTRICT,
  request_id text REFERENCES editorial_human_decision_requests(id)
    ON DELETE RESTRICT,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (
    jsonb_typeof(metadata) = 'object' AND
    octet_length(metadata::text) <= 8000
  ),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX editorial_orchestration_runs_status_idx
  ON editorial_orchestration_runs(status, created_at);

CREATE INDEX editorial_orchestration_steps_run_idx
  ON editorial_orchestration_steps(run_id, position);

CREATE INDEX editorial_human_decision_requests_pending_idx
  ON editorial_human_decision_requests(status, expires_at)
  WHERE status IN ('PENDING', 'DELIVERED');

CREATE INDEX editorial_orchestration_events_run_idx
  ON editorial_orchestration_events(run_id, occurred_at, id);
