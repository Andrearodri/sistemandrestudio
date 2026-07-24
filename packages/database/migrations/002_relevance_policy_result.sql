CREATE TABLE editorial_relevance_results (
  news_id text PRIMARY KEY
    REFERENCES editorial_news(id)
    ON DELETE RESTRICT,
  result jsonb NOT NULL CHECK (
    jsonb_typeof(result) = 'object'
    AND result ?& ARRAY[
      'value',
      'threshold',
      'reason',
      'policyId',
      'policyVersion',
      'evaluatedAt',
      'criteria',
      'penalties',
      'recognizedTopics',
      'positiveFactors',
      'negativeFactors',
      'priority',
      'decision',
      'weights',
      'thresholds'
    ]
  )
);

CREATE INDEX editorial_relevance_results_policy_idx
  ON editorial_relevance_results (
    (result->>'policyId'),
    (result->>'policyVersion')
  );

INSERT INTO editorial_relevance_results (news_id, result)
SELECT
  id,
  jsonb_build_object(
    'value', relevance_score,
    'threshold', (relevance->>'threshold')::smallint,
    'reason', relevance->>'reason',
    'policyId', 'legacy-relevance',
    'policyVersion', relevance->>'policyVersion',
    'evaluatedAt', to_char(
      updated_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'criteria', jsonb_build_array(
      jsonb_build_object(
        'criterion', 'TOPIC_AFFINITY',
        'score', relevance_score,
        'maxScore', 100,
        'reasons', jsonb_build_array(
          jsonb_build_object(
            'code', 'LEGACY_BREAKDOWN_UNAVAILABLE',
            'message', 'Only the legacy total score was persisted.'
          )
        )
      ),
      jsonb_build_object(
        'criterion', 'SOURCE_AUTHORITY',
        'score', 0,
        'maxScore', 0,
        'reasons', '[]'::jsonb
      ),
      jsonb_build_object(
        'criterion', 'FRESHNESS',
        'score', 0,
        'maxScore', 0,
        'reasons', '[]'::jsonb
      ),
      jsonb_build_object(
        'criterion', 'TECHNICAL_IMPACT',
        'score', 0,
        'maxScore', 0,
        'reasons', '[]'::jsonb
      ),
      jsonb_build_object(
        'criterion', 'COMMERCIAL_POTENTIAL',
        'score', 0,
        'maxScore', 0,
        'reasons', '[]'::jsonb
      ),
      jsonb_build_object(
        'criterion', 'CONTENT_POTENTIAL',
        'score', 0,
        'maxScore', 0,
        'reasons', '[]'::jsonb
      )
    ),
    'penalties', '[]'::jsonb,
    'recognizedTopics', '[]'::jsonb,
    'positiveFactors', '[]'::jsonb,
    'negativeFactors', '[]'::jsonb,
    'priority', CASE
      WHEN relevance_score >= 85 THEN 'CRITICAL'
      WHEN relevance_score >= 70 THEN 'HIGH'
      WHEN relevance_score >= 50 THEN 'MEDIUM'
      WHEN relevance_score >= 30 THEN 'LOW'
      ELSE 'IGNORE'
    END,
    'decision', CASE
      WHEN relevance_score >= 85 THEN 'FAST_TRACK'
      WHEN relevance_score >= 70 THEN 'CONTINUE_TO_VERIFICATION'
      WHEN relevance_score >= 50 THEN 'HOLD_FOR_REVIEW'
      ELSE 'DISCARD_LOW_RELEVANCE'
    END,
    'weights', jsonb_build_object(
      'TOPIC_AFFINITY', 100,
      'SOURCE_AUTHORITY', 0,
      'FRESHNESS', 0,
      'TECHNICAL_IMPACT', 0,
      'COMMERCIAL_POTENTIAL', 0,
      'CONTENT_POTENTIAL', 0
    ),
    'thresholds', jsonb_build_object(
      'criticalMin', 85,
      'highMin', 70,
      'mediumMin', 50,
      'lowMin', 30,
      'verificationMin', (relevance->>'threshold')::smallint,
      'duplicateSimilarity', 0.75,
      'probableDuplicateSimilarity', 0.9,
      'oldEventDays', 90,
      'recentPresentationDays', 14
    )
  )
FROM editorial_news
WHERE relevance IS NOT NULL
  AND relevance_score IS NOT NULL;
