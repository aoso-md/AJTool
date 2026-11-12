\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';

-- The lookup key may be an input ID or an outbox event ID.
-- Keep raw_input, data, metadata and free-text errors out of the result.
WITH request AS (
  SELECT :'tool'::text AS tool, :'event_id'::text AS event_id
), matched_output AS (
  SELECT o.study_id, o.envelope_text::jsonb #>> '{causation_id}' AS cause_id
  FROM request r
  JOIN public.event_outbox o USING (tool, event_id)
), lookup AS (
  SELECT r.*, m.study_id AS output_study_id, coalesce(m.cause_id, r.event_id) AS input_id
  FROM request r LEFT JOIN matched_output m ON true
)
SELECT jsonb_build_object(
  'tool', k.tool,
  'event_id', k.event_id,
  'tier', 'postgres',
  'runtime_mode', runtime.publish_mode,
  'subscription_cursor', cursor.seq::text,
  'input', jsonb_build_object(
    'event_id', coalesce(i.event_id, s.input_event_id),
    'received', CASE WHEN i.event_id IS NOT NULL OR s.input_event_id IS NOT NULL THEN true END,
    'receipt_recorded', i.event_id IS NOT NULL,
    'seq', coalesce(i.source_seq::text, s.doc ->> 'inputSeq', s.doc #>> '{parent,seq}'),
    'producer', coalesce(i.canonical_input #>> '{module,id}', s.doc ->> 'inputModuleId', s.doc #>> '{parent,module,id}'),
    'type', coalesce(i.canonical_input ->> 'type', s.doc #>> '{parent,type}'),
    'asset_id', coalesce(i.canonical_input #>> '{asset,asset_id}', s.doc #>> '{asset,asset_id}'),
    'correlation_id', coalesce(i.canonical_input ->> 'correlationId', s.doc ->> 'correlationId', s.doc #>> '{parent,correlationId}'),
    'causation_id', coalesce(i.canonical_input ->> 'causationId', s.doc #>> '{parent,causationId}'),
    'outcome', i.outcome,
    'rejection_code', rejection.code
  ),
  'study', CASE WHEN coalesce(s.id, i.study_id, k.output_study_id) IS NOT NULL THEN jsonb_build_object(
    'id', coalesce(s.id, i.study_id, k.output_study_id),
    'found', s.id IS NOT NULL,
    'status', s.status,
    'gauge_id', s.doc ->> 'gaugeId',
    'publication_state', s.doc #>> '{publish,state}',
    'publication_event_id', s.doc #>> '{publish,eventId}'
  ) END,
  'outputs', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'event_id', o.event_id,
      'type', o.envelope_text::jsonb #>> '{event,type}',
      'correlation_id', o.envelope_text::jsonb ->> 'correlation_id',
      'causation_id', o.envelope_text::jsonb ->> 'causation_id',
      'mode', o.mode,
      'state', o.state,
      'attempts', o.attempts,
      'error_class', o.last_error_class
    ) ORDER BY o.outbox_id)
    FROM public.event_outbox o
    WHERE o.tool = k.tool AND (o.event_id = k.event_id OR o.study_id = s.id)
  ), '[]'::jsonb)
)
FROM lookup k
LEFT JOIN public.event_inbox i ON i.tool = k.tool AND i.event_id = k.input_id
LEFT JOIN LATERAL (
  SELECT study.id, study.status, study.input_event_id, study.doc
  FROM public.studies study
  WHERE study.tool = k.tool AND (
    study.id = coalesce(i.study_id, k.output_study_id)
    OR (coalesce(i.study_id, k.output_study_id) IS NULL AND study.input_event_id = k.input_id)
  )
) s ON true
LEFT JOIN public.consumer_cursors cursor ON cursor.name = 'subscription:' || k.tool
LEFT JOIN public.runtime_identity runtime ON runtime.tool = k.tool
LEFT JOIN LATERAL (
  SELECT code FROM public.event_rejections
  WHERE tool = k.tool AND event_id = k.input_id
  ORDER BY rejection_id DESC LIMIT 1
) rejection ON true;

COMMIT;
