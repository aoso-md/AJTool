import assert from 'node:assert/strict';
import pg from 'pg';
import {readSource,parseFilters} from '../src/queries.mjs';
assert.equal(process.env.ANALYTICS_MODE,'local-synthetic');
const results=[];
for(const [id,tool] of [['cpk','calculate_cpk_ppk'],['msa','run_msa_analysis']]){
 const url=process.env[id.toUpperCase()+'_DATABASE_URL'];assert.equal(new URL(url).hostname,'db');
 const pool=new pg.Pool({connectionString:url,max:1});
 try{
  const privileges=(await pool.query("SELECT current_setting('default_transaction_read_only') AS readonly,has_table_privilege(current_user,'public.studies','SELECT') AS raw,has_table_privilege(current_user,'ajtool_analytics.studies','SELECT') AS projected")).rows[0];
  assert.equal(privileges.readonly,'on');assert.equal(privileges.raw,false);assert.equal(privileges.projected,true);
  await assert.rejects(pool.query('SELECT doc FROM public.studies'),{code:'42501'});
  await pool.query('SET default_transaction_read_only=off');
  await assert.rejects(pool.query("INSERT INTO public.studies(id,tool,status,created_at,updated_at,doc) VALUES ('should-never-write','invalid','invalid',now(),now(),'{}')"),{code:'42501'});
  await pool.query('SET default_transaction_read_only=on');
  const before=(await pool.query('SELECT count(*)::int AS n FROM ajtool_analytics.studies')).rows[0].n;
  const data=await readSource(pool,{id,tool},parseFilters({pageSize:1}));
  assert.equal(data.rows.length,1);assert.equal(data.counts.reduce((n,x)=>n+x.count,0),before);
  assert.equal(data.timeline.reduce((n,x)=>n+x.count,0),before);
  const page2=await readSource(pool,{id,tool},parseFilters({page:2,pageSize:1}));
  assert.ok(page2.rows[0]);assert.notEqual(data.rows[0].id,page2.rows[0].id);
  const empty=await readSource(pool,{id,tool},parseFilters({q:'NO-SUCH-SYNTHETIC-RECORD'}));assert.equal(empty.rows.length,0);assert.equal(empty.counts.length,0);
  const injection=await readSource(pool,{id,tool},parseFilters({q:"'; DROP TABLE studies; --"}));assert.equal(injection.rows.length,0);
  const noData=await readSource(pool,{id,tool},parseFilters({from:'2020-01-01',to:'2020-01-02'}));assert.equal(noData.rows.length,0);
  const records=(await pool.query('SELECT record FROM ajtool_analytics.studies')).rows;
  for(const {record} of records){assert.ok(!('actor' in record));assert.ok(!('notes' in record));assert.ok(!('input' in record));assert.ok(!JSON.stringify(record).includes('operatorId'));}
  const after=(await pool.query('SELECT count(*)::int AS n FROM ajtool_analytics.studies')).rows[0].n;assert.equal(before,after);
  assert.ok(data.queryMs<2000);
  results.push({source:id,readonlyRole:true,rawTableDenied:true,writeDenied:true,total:before,countsReconciled:true,dayTotalsReconciled:true,pagination:true,emptyFilter:true,injectionBound:true,dateFilter:true,personalAndRawDataOmitted:true,rowsUnchanged:true,queryMs:data.queryMs,quality:data.quality});
 }finally{await pool.end();}
}
console.log(JSON.stringify({status:'PASS',results},null,2));
