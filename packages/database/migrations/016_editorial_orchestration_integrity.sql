ALTER TABLE editorial_human_decisions
  ADD CONSTRAINT editorial_human_decisions_changes_required CHECK (
    decision <> 'REQUEST_CHANGES' OR (
      change_instructions IS NOT NULL AND
      jsonb_typeof(change_instructions) = 'array' AND
      jsonb_array_length(change_instructions) > 0
    )
  );
