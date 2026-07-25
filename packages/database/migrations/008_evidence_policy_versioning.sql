ALTER TABLE evidence_acquisition_runs
  DROP CONSTRAINT evidence_acquisition_runs_policy_version_check,
  DROP CONSTRAINT evidence_acquisition_runs_source_policy_version_check;

ALTER TABLE evidence_acquisition_runs
  ADD CONSTRAINT evidence_acquisition_policy_version_check
    CHECK (
      char_length(policy_version) BETWEEN 1 AND 100
    ),
  ADD CONSTRAINT evidence_acquisition_source_policy_version_check
    CHECK (
      char_length(source_policy_version) BETWEEN 1 AND 100
    );
