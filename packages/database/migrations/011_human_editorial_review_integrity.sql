ALTER TABLE editorial_review_decisions
  ADD COLUMN news_id text REFERENCES editorial_news(id) ON DELETE RESTRICT,
  ADD COLUMN command_id text,
  ADD COLUMN functional_fingerprint text,
  ADD COLUMN policy_id text DEFAULT 'andre-studio-human-review',
  ADD COLUMN created_at timestamptz;
UPDATE editorial_review_decisions SET news_id=d.news_id, command_id=editorial_review_decisions.id,
  functional_fingerprint=editorial_review_decisions.idempotency_key,
  created_at=editorial_review_decisions.reviewed_at
FROM editorial_drafts d WHERE d.id=editorial_review_decisions.draft_id;
ALTER TABLE editorial_review_decisions ALTER COLUMN news_id SET NOT NULL;
ALTER TABLE editorial_review_decisions ALTER COLUMN command_id SET NOT NULL;
ALTER TABLE editorial_review_decisions ALTER COLUMN functional_fingerprint SET NOT NULL;
ALTER TABLE editorial_review_decisions ALTER COLUMN policy_id SET NOT NULL;
ALTER TABLE editorial_review_decisions ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE editorial_revision_requests RENAME COLUMN decision_id TO review_decision_id;
ALTER TABLE editorial_revision_requests ADD COLUMN id text;
UPDATE editorial_revision_requests SET id=review_decision_id;
ALTER TABLE editorial_revision_requests ALTER COLUMN id SET NOT NULL;
ALTER TABLE editorial_revision_requests ADD CONSTRAINT editorial_revision_requests_id_unique UNIQUE(id);
ALTER TABLE editorial_revision_requests
  ADD COLUMN source_draft_id text REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  ADD COLUMN revised_draft_id text REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
  ADD COLUMN fulfilled_at timestamptz;
UPDATE editorial_revision_requests r SET source_draft_id=d.draft_id
FROM editorial_review_decisions d WHERE d.id=r.review_decision_id;
ALTER TABLE editorial_revision_requests ALTER COLUMN source_draft_id SET NOT NULL;

ALTER TABLE editorial_drafts DROP CONSTRAINT IF EXISTS editorial_drafts_brief_id_format_generator_id_generator_version_key;
ALTER TABLE editorial_drafts ADD COLUMN version_number integer NOT NULL DEFAULT 1 CHECK(version_number > 0);
ALTER TABLE editorial_drafts ADD COLUMN source_draft_id text REFERENCES editorial_drafts(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX editorial_drafts_news_format_version_uq ON editorial_drafts(news_id,format,version_number);
