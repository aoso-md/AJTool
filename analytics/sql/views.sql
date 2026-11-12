-- Additive, minimized read model. Run ONLY in the verified local synthetic staging.
-- No changes to public tables, original migrations or transactional handlers.
BEGIN;
CREATE SCHEMA IF NOT EXISTS ajtool_analytics;
CREATE OR REPLACE VIEW ajtool_analytics.studies WITH (security_barrier=true) AS
SELECT s.id,s.tool,s.status,s.created_at,s.updated_at,s.input_event_id,
  NULLIF(s.doc#>>'{asset,plant_id}','') AS plant_id,
  jsonb_build_object(
    'id',s.id,'tool',s.tool,'status',s.status,'createdAt',s.created_at,'updatedAt',s.updated_at,
    'partId',s.doc->'partId','characteristicId',s.doc->'characteristicId','gaugeId',s.doc->'gaugeId',
    'source',s.doc->'source','plantId',NULLIF(s.doc#>>'{asset,plant_id}',''),
    'spec',jsonb_build_object('version',s.doc#>'{spec,version}','lsl',s.doc#>'{spec,lsl}','usl',s.doc#>'{spec,usl}','source',s.doc#>'{spec,source}'),
    'criteriaVersion',s.doc#>'{criteria,version}','publishState',s.doc#>'{publish,state}',
    'method',s.doc#>'{result,method}',
    'result',(SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(s.doc->'result')='object' THEN s.doc->'result' ELSE '{}'::jsonb END)
      WHERE key=ANY(ARRAY['cp','cpk','pp','ppk','mean','sigmaWithin','sigmaOverall','sampleSize','minimumCpk','status','method','repeatability','reproducibility','grr','partVariation','totalVariation','gageRRPercent','contributionPercent','ndc','verdict','parts','appraisers','trials'])),
    'rawCount',raw.n,'invalidRawValues',raw.invalid,'rawMean',raw.mean,
    'documentIdentityMismatch',s.doc->>'id' IS DISTINCT FROM s.id OR s.doc->>'tool' IS DISTINCT FROM s.tool,
    'documentTimeMismatch',s.doc->>'createdAt' IS NULL OR s.doc->>'updatedAt' IS NULL,
    'documentCreatedAt',s.doc->>'createdAt','documentUpdatedAt',s.doc->>'updatedAt',
    'documentStatus',s.doc->>'status',
    'platformLineageUnresolved',s.doc->>'source'='platform' AND (s.input_event_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.event_inbox i WHERE i.tool=s.tool AND i.event_id=s.input_event_id))
  ) AS record,
  md5(COALESCE((s.doc->'input')::text,'')) AS input_fingerprint
FROM public.studies s
LEFT JOIN LATERAL (
  SELECT count(*)::int AS n,
    count(*) FILTER(WHERE jsonb_typeof(v)<>'number')::int AS invalid,
    avg(CASE WHEN jsonb_typeof(v)='number' THEN (v#>>'{}')::numeric END) AS mean
  FROM jsonb_array_elements(CASE
    WHEN jsonb_typeof(s.doc#>'{input,measurements}')='array' THEN s.doc#>'{input,measurements}'
    WHEN jsonb_typeof(s.doc#>'{input,observations}')='array' THEN (SELECT COALESCE(jsonb_agg(o->'value'),'[]'::jsonb) FROM jsonb_array_elements(s.doc#>'{input,observations}') o)
    ELSE '[]'::jsonb END) v
) raw ON true;

CREATE OR REPLACE VIEW ajtool_analytics.inbox WITH (security_barrier=true) AS
SELECT i.tool,i.outcome,i.received_at,
 COALESCE(s.plant_id,NULLIF(i.canonical_input#>>'{asset,plant_id}','')) AS plant_id,
 (SELECT count(*) FROM public.event_rejections r WHERE r.tool=i.tool AND r.event_id=i.event_id)::int AS rejection_count
FROM public.event_inbox i LEFT JOIN ajtool_analytics.studies s ON s.tool=i.tool AND s.id=i.study_id;

CREATE OR REPLACE VIEW ajtool_analytics.outbox WITH (security_barrier=true) AS
SELECT o.tool,o.state,o.mode,o.created_at,o.attempts,s.plant_id
FROM public.event_outbox o LEFT JOIN ajtool_analytics.studies s ON s.id=o.study_id AND s.tool=o.tool;

CREATE OR REPLACE VIEW ajtool_analytics.runtime WITH (security_barrier=true) AS
SELECT tool,environment,publish_mode,schema_version,updated_at FROM public.runtime_identity;
COMMIT;
