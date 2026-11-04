import {qualityFlags,comparability} from './quality.mjs';
export function parseFilters(input={}){
  if(!input||Array.isArray(input)||typeof input!=='object')throw new Error('invalid_filter');
  const allowed=['view','tool','status','from','to','q','page','pageSize','plant'];
  if(Object.keys(input).some(k=>!allowed.includes(k)))throw new Error('invalid_filter');
  const f={view:input.view||'overview',tool:input.tool||'all',status:input.status||'all',from:input.from||null,to:input.to||null,q:input.q||'',page:input.page??1,pageSize:input.pageSize??25,plant:input.plant??'unassigned'};
  if(!['overview','cpk','msa','reliability','quality'].includes(f.view)||!['all','cpk','msa'].includes(f.tool)||!['all','completed','pending','invalid'].includes(f.status))throw new Error('invalid_filter');
  if(!Number.isInteger(f.page)||f.page<1||f.page>10000||!Number.isInteger(f.pageSize)||f.pageSize<1||f.pageSize>100||typeof f.q!=='string'||f.q.length>80)throw new Error('invalid_filter');
  for(const date of [f.from,f.to])if(date!==null&&(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date))throw new Error('invalid_date');
  if(f.from&&f.to&&f.from>f.to)throw new Error('invalid_date_range');
  if(f.plant!=='unassigned')throw Object.assign(new Error('scope_denied'),{status:403});
  if(f.view==='cpk')f.tool='cpk';if(f.view==='msa')f.tool='msa';
  return f;
}
export function where(f,tool){
  const values=[tool];let sql='tool=$1 AND plant_id IS NULL';
  if(f.from){values.push(f.from);sql+=` AND created_at >= $${values.length}::date`;}
  if(f.to){values.push(f.to);sql+=` AND created_at < ($${values.length}::date + interval '1 day')`;}
  if(f.status!=='all'){values.push(f.status==='invalid'?['skipped','error']:[f.status]);sql+=` AND status=ANY($${values.length}::text[])`;}
  if(f.q){values.push('%'+f.q.replace(/[\\%_]/g,'\\$&')+'%');sql+=` AND concat_ws(' ',record->>'partId',record->>'characteristicId',record->>'gaugeId') ILIKE $${values.length} ESCAPE '\'`;}
  return {sql,values};
}
export async function readSource(pool,source,f){
  const client=await pool.connect();const started=performance.now();
  try{
    await client.query('BEGIN READ ONLY');await client.query("SET LOCAL statement_timeout='2000ms'");
    const w=where(f,source.tool);
    const counts=(await client.query(`SELECT status,count(*)::int AS count FROM ajtool_analytics.studies WHERE ${w.sql} GROUP BY status`,w.values)).rows;
    const timeline=(await client.query(`SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*)::int AS count FROM ajtool_analytics.studies WHERE ${w.sql} GROUP BY day ORDER BY day`,w.values)).rows;
    const offset=(f.page-1)*f.pageSize;
    const rows=(await client.query(`SELECT record FROM ajtool_analytics.studies WHERE ${w.sql} ORDER BY created_at DESC,id LIMIT $${w.values.length+1} OFFSET $${w.values.length+2}`,[...w.values,f.pageSize,offset])).rows.map(x=>({...x.record,sourceId:source.id}));
    const quality=(await client.query(`SELECT record FROM ajtool_analytics.studies WHERE ${w.sql} ORDER BY created_at DESC,id LIMIT 1000`,w.values)).rows.map(x=>x.record);
    const duplicates=(await client.query(`SELECT count(*)::int AS groups,coalesce(sum(n-1),0)::int AS extra FROM (SELECT count(*) n FROM ajtool_analytics.studies WHERE ${w.sql} GROUP BY input_fingerprint HAVING count(*)>1) d`,w.values)).rows[0];
    // Reliability uses the same date/plant scope; entity/status filters are not applied to event ledgers.
    const ledgerValues=[source.tool];let ledger='tool=$1 AND plant_id IS NULL';
    if(f.from){ledgerValues.push(f.from);ledger+=` AND created_at >= $${ledgerValues.length}::date`;}
    if(f.to){ledgerValues.push(f.to);ledger+=` AND created_at < ($${ledgerValues.length}::date+interval '1 day')`;}
    const outbox=(await client.query(`SELECT state,mode,count(*)::int AS count,sum(attempts)::int AS attempts FROM ajtool_analytics.outbox WHERE ${ledger} GROUP BY state,mode`,ledgerValues)).rows;
    const inbox=(await client.query(`SELECT outcome,count(*)::int AS count,sum(rejection_count)::int AS rejections FROM ajtool_analytics.inbox WHERE ${ledger.replaceAll('created_at','received_at')} GROUP BY outcome`,ledgerValues)).rows;
    const runtime=(await client.query('SELECT environment,publish_mode,schema_version,updated_at FROM ajtool_analytics.runtime WHERE tool=$1',[source.tool])).rows;
    await client.query('COMMIT');
    return {source:source.id,counts,timeline,rows:rows.map(s=>({...s,quality:qualityFlags(s),comparability:comparability(s)})),quality:{inspected:quality.length,completed:quality.filter(s=>s.status==='completed').length,cap:1000,flags:quality.reduce((a,s)=>{for(const k of qualityFlags(s))a[k]=(a[k]||0)+1;return a;},{})},duplicates,outbox,inbox,runtime,queryMs:Math.round(performance.now()-started)};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}finally{client.release();}
}
