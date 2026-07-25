CREATE TABLE editorial_review_decisions (
  id text PRIMARY KEY, draft_id text NOT NULL REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  draft_version integer NOT NULL CHECK (draft_version > 0), news_version integer NOT NULL CHECK (news_version > 0),
  reviewer_id text NOT NULL CHECK (reviewer_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$'),
  decision text NOT NULL CHECK (decision IN ('APPROVE','REQUEST_REVISION','REJECT')),
  reason text CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 2000), idempotency_key text NOT NULL UNIQUE,
  policy_version text NOT NULL DEFAULT 'andre-studio-human-review-v1', reviewed_at timestamptz NOT NULL
);
CREATE TABLE editorial_revision_requests (
  decision_id text PRIMARY KEY REFERENCES editorial_review_decisions(id) ON DELETE RESTRICT,
  instructions jsonb NOT NULL CHECK (jsonb_typeof(instructions) = 'array'), status text NOT NULL CHECK (status IN ('OPEN','FULFILLED')),
  source_version integer NOT NULL, revised_version integer, created_at timestamptz NOT NULL
);
CREATE INDEX editorial_review_pending_idx ON editorial_review_decisions(draft_id, reviewed_at);
