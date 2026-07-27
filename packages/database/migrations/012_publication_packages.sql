CREATE TABLE publication_packages (
 id text PRIMARY KEY, news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
 news_version integer NOT NULL CHECK(news_version>=0), draft_id text NOT NULL REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
 draft_version integer NOT NULL CHECK(draft_version>0), approval_decision_id text NOT NULL REFERENCES editorial_review_decisions(id) ON DELETE RESTRICT,
 destination text NOT NULL CHECK(destination IN('LINKEDIN_EXPORT','WEBSITE_EXPORT')),
 policy_id text NOT NULL, policy_version text NOT NULL, content_hash text NOT NULL CHECK(char_length(content_hash)=64),
 functional_fingerprint text NOT NULL UNIQUE CHECK(char_length(functional_fingerprint)=64),
 status text NOT NULL CHECK(status IN('CREATED','VALIDATED','EXPORTED','READY_FOR_PUBLICATION','FAILED')),
 reviewer_id text NOT NULL, approved_at timestamptz NOT NULL, created_at timestamptz NOT NULL, exported_at timestamptz,
 idempotency_key text NOT NULL UNIQUE, UNIQUE(draft_id,draft_version,destination,policy_version)
);
CREATE TABLE publication_package_files (
 publication_id text NOT NULL REFERENCES publication_packages(id) ON DELETE RESTRICT,
 file_role text NOT NULL CHECK(file_role IN('CONTENT_MARKDOWN','CONTENT_JSON','MANIFEST')),
 relative_path text NOT NULL CHECK(relative_path !~ '(^/|\\.\\.|\\\\)' AND char_length(relative_path)<=300),
 content_hash text NOT NULL CHECK(char_length(content_hash)=64), size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 1000000),
 created_at timestamptz NOT NULL, PRIMARY KEY(publication_id,file_role)
);
CREATE TABLE publication_package_citations (
 publication_id text NOT NULL REFERENCES publication_packages(id) ON DELETE RESTRICT,
 citation_id text NOT NULL, source text NOT NULL, title text NOT NULL, canonical_url text NOT NULL CHECK(canonical_url ~ '^https://'),
 claim_id text NOT NULL, evidence_id text NOT NULL, published_at timestamptz,
 PRIMARY KEY(publication_id,citation_id)
);
CREATE INDEX publication_packages_news_idx ON publication_packages(news_id,created_at);
