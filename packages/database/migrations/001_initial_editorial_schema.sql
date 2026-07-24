CREATE TABLE editorial_news (
  id text PRIMARY KEY,
  state text NOT NULL CHECK (
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
      'READY_FOR_PUBLICATION'
    )
  ),
  source jsonb NOT NULL,
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  base_content text NOT NULL,
  original_url text NOT NULL,
  canonical_url text,
  published_at timestamptz NOT NULL,
  event_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  duplicate_of_news_id text,
  relevance_score smallint CHECK (
    relevance_score IS NULL OR relevance_score BETWEEN 0 AND 100
  ),
  relevance jsonb,
  verification_result jsonb,
  current_draft_version_id text,
  current_approval_request_id text,
  lock_version integer NOT NULL DEFAULT 0 CHECK (lock_version >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE draft_versions (
  id text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  version_number integer NOT NULL CHECK (version_number > 0),
  body text NOT NULL CHECK (length(btrim(body)) > 0),
  change_reason text,
  actor_type text NOT NULL CHECK (
    actor_type IN ('SYSTEM', 'HUMAN', 'N8N', 'TELEGRAM', 'LLM')
  ),
  actor_id text NOT NULL,
  based_on_version_id text REFERENCES draft_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL,
  UNIQUE (news_id, version_number)
);

CREATE TABLE approval_requests (
  id text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  draft_version_id text NOT NULL REFERENCES draft_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (
    status IN ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED')
  ),
  requested_at timestamptz NOT NULL,
  resolved_at timestamptz
);

CREATE TABLE approval_actions (
  id text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  approval_request_id text NOT NULL
    REFERENCES approval_requests(id) ON DELETE RESTRICT,
  draft_version_id text NOT NULL
    REFERENCES draft_versions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (
    decision IN ('APPROVE', 'REQUEST_CHANGES', 'REJECT')
  ),
  actor_type text NOT NULL CHECK (actor_type = 'HUMAN'),
  actor_id text NOT NULL,
  reason text,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

CREATE TABLE audit_events (
  id text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  previous_state text NOT NULL,
  new_state text NOT NULL,
  action text NOT NULL,
  actor_type text NOT NULL CHECK (
    actor_type IN ('SYSTEM', 'HUMAN', 'N8N', 'TELEGRAM', 'LLM')
  ),
  actor_id text NOT NULL,
  reason text,
  content_version_id text REFERENCES draft_versions(id) ON DELETE RESTRICT,
  idempotency_key text,
  technical_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL
);

CREATE TABLE processed_commands (
  idempotency_key text PRIMARY KEY,
  news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
  command_type text NOT NULL,
  command_fingerprint text NOT NULL,
  result jsonb NOT NULL,
  processed_at timestamptz NOT NULL
);

ALTER TABLE editorial_news
  ADD CONSTRAINT editorial_news_current_draft_fk
  FOREIGN KEY (current_draft_version_id)
  REFERENCES draft_versions(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE editorial_news
  ADD CONSTRAINT editorial_news_current_approval_fk
  FOREIGN KEY (current_approval_request_id)
  REFERENCES approval_requests(id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX editorial_news_state_idx
  ON editorial_news(state);

CREATE INDEX editorial_news_updated_at_idx
  ON editorial_news(updated_at);

CREATE INDEX draft_versions_news_idx
  ON draft_versions(news_id, version_number);

CREATE INDEX approval_requests_news_idx
  ON approval_requests(news_id, requested_at);

CREATE INDEX approval_actions_news_idx
  ON approval_actions(news_id, created_at);

CREATE INDEX audit_events_news_order_idx
  ON audit_events(news_id, occurred_at, id);

CREATE INDEX processed_commands_news_idx
  ON processed_commands(news_id, processed_at);

CREATE FUNCTION enforce_ready_for_publication_approval()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.state = 'READY_FOR_PUBLICATION' AND NOT EXISTS (
    SELECT 1
    FROM approval_requests request
    JOIN approval_actions action
      ON action.approval_request_id = request.id
    WHERE request.id = NEW.current_approval_request_id
      AND request.news_id = NEW.id
      AND request.draft_version_id = NEW.current_draft_version_id
      AND request.status = 'APPROVED'
      AND action.decision = 'APPROVE'
      AND action.draft_version_id = NEW.current_draft_version_id
  ) THEN
    RAISE EXCEPTION
      'READY_FOR_PUBLICATION requires approval of the current draft version'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE CONSTRAINT TRIGGER editorial_news_ready_requires_approval
AFTER INSERT OR UPDATE OF state, current_draft_version_id, current_approval_request_id
ON editorial_news
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_ready_for_publication_approval();
