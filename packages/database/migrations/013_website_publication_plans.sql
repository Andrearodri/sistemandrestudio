CREATE TABLE website_publication_plans (
 id text PRIMARY KEY,
 publication_id text NOT NULL REFERENCES publication_packages(id) ON DELETE RESTRICT,
 news_id text NOT NULL REFERENCES editorial_news(id) ON DELETE RESTRICT,
 draft_id text NOT NULL REFERENCES editorial_drafts(id) ON DELETE RESTRICT,
 draft_version integer NOT NULL CHECK(draft_version > 0),
 mode text NOT NULL CHECK(mode = 'DRY_RUN'),
 target_profile_id text NOT NULL,
 profile_version text NOT NULL,
 public_base_url text NOT NULL CHECK(public_base_url ~ '^https://'),
 legacy_technical_base_url text CHECK(legacy_technical_base_url ~ '^https://'),
 policy_id text NOT NULL,
 policy_version text NOT NULL,
 slug text NOT NULL CHECK(slug !~ '[/\\\\]' AND char_length(slug) BETWEEN 1 AND 120),
 source_files jsonb NOT NULL CHECK(jsonb_typeof(source_files) = 'array'),
 destination_files jsonb NOT NULL CHECK(jsonb_typeof(destination_files) = 'array'),
 package_content_hash text NOT NULL CHECK(char_length(package_content_hash) = 64),
 functional_fingerprint text NOT NULL UNIQUE CHECK(char_length(functional_fingerprint) = 64),
 status text NOT NULL CHECK(status IN('CREATED','VALIDATED','DRY_RUN_COMPLETED','FAILED')),
 validation_status text NOT NULL CHECK(validation_status IN('VALID','VALID_WITH_WARNINGS','BLOCKED')),
 provisional_public_url text NOT NULL CHECK(provisional_public_url ~ '^https://'),
 detected_platform text NOT NULL CHECK(detected_platform = 'UNKNOWN'),
 publication_strategy text NOT NULL CHECK(publication_strategy IN('STATIC_MARKDOWN','STATIC_JSON','REPOSITORY_CONTENT','UNKNOWN')),
 content_directory text NOT NULL,
 route_pattern text NOT NULL,
 requires_build text NOT NULL CHECK(requires_build IN('TRUE','FALSE','UNKNOWN')),
 requires_restart text NOT NULL CHECK(requires_restart IN('TRUE','FALSE','UNKNOWN')),
 warnings jsonb NOT NULL CHECK(jsonb_typeof(warnings) = 'array'),
 idempotency_key text NOT NULL UNIQUE,
 command_id text NOT NULL,
 created_at timestamptz NOT NULL,
 UNIQUE(publication_id,target_profile_id,profile_version,policy_version,mode)
);

CREATE TABLE website_publication_plan_operations (
 plan_id text NOT NULL REFERENCES website_publication_plans(id) ON DELETE RESTRICT,
 position integer NOT NULL CHECK(position >= 0),
 operation_code text NOT NULL,
 description text NOT NULL,
 source_path text,
 destination_path text,
 condition text NOT NULL,
 required boolean NOT NULL,
 local_execution boolean NOT NULL,
 status text NOT NULL CHECK(status IN('PLANNED','PROVISIONAL','REQUIRES_TARGET_INSPECTION','REQUIRES_CONFIRMATION','BLOCKED_IN_DRY_RUN')),
 is_remote boolean NOT NULL,
 PRIMARY KEY(plan_id,position),
 UNIQUE(plan_id,operation_code)
);

CREATE TABLE website_publication_plan_prerequisites (
 plan_id text NOT NULL REFERENCES website_publication_plans(id) ON DELETE RESTRICT,
 prerequisite_code text NOT NULL,
 description text NOT NULL,
 required boolean NOT NULL,
 status text NOT NULL CHECK(status IN('CONFIRMED','PENDING','UNKNOWN')),
 PRIMARY KEY(plan_id,prerequisite_code)
);

CREATE INDEX website_publication_plans_publication_idx
 ON website_publication_plans(publication_id,created_at);
