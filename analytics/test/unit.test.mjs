import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:net';
import {parseFilters,where} from '../src/queries.mjs';
import {qualityFlags,comparability} from '../src/quality.mjs';
import {createAnalyticsApp} from '../src/app.mjs';
test('strict filters reject unknown dimensions and invalid dates',()=>{
 for(const value of [null,[],{tool:'injected'},{column:'doc'},{from:'2026-02-30'},{from:'2026-11-01',to:'2026-10-01'},{page:0},{pageSize:101},{q:'x'.repeat(81)}])assert.throws(()=>parseFilters(value));
});
test('plant authorization fails closed; client cannot claim a new scope',()=>{
 assert.throws(()=>parseFilters({plant:'another-plant'}),{status:403});
});
test('entity search is bound as a parameter; wildcards are literal',()=>{
 const f=parseFilters({q:"%'; DROP TABLE studies; --"});const w=where(f,'calculate_cpk_ppk');
 assert.ok(!w.sql.includes('DROP TABLE'));assert.equal(w.values[0],'calculate_cpk_ppk');assert.ok(w.values[1].includes('\\%'));
});
test('tool-specific views force their own source',()=>{
 assert.equal(parseFilters({view:'cpk',tool:'msa'}).tool,'cpk');assert.equal(parseFilters({view:'msa',tool:'cpk'}).tool,'msa');
});
const fixture={tool:'calculate_cpk_ppk',status:'completed',source:'manual',createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T00:00:00Z',spec:{version:'v1'},rawCount:4,invalidRawValues:0,rawMean:11,result:{cp:1.128,cpk:1.128,pp:1.7321,ppk:1.7321,mean:11,sampleSize:4}};
test('quality reconciles raw count and mean, preserving missing metadata',()=>{
 const flags=qualityFlags(fixture);assert.ok(flags.includes('unit_not_recorded'));assert.ok(!flags.includes('raw_count_mismatch'));
 assert.ok(qualityFlags({...fixture,rawCount:3}).includes('raw_count_mismatch'));
 assert.ok(qualityFlags({...fixture,rawMean:12}).includes('raw_mean_mismatch'));
});
test('nonfinite results and reversed timestamps are flagged',()=>{
 assert.ok(qualityFlags({...fixture,result:{...fixture.result,cpk:Infinity}}).includes('incomplete_or_nonfinite_result'));
 assert.ok(qualityFlags({...fixture,updatedAt:'2026-10-01T00:00:00Z'}).includes('invalid_timestamp'));
});
test('unknown unit or method revision never becomes a comparable trend',()=>{
 assert.equal(comparability(fixture).eligible,false);
});
test('MSA checks GRR components and study-variation denominator independently',()=>{
 const s={...fixture,tool:'run_msa_analysis',method:'AIAG average & range',rawCount:12,result:{repeatability:3,reproducibility:4,grr:5,partVariation:12,totalVariation:13,gageRRPercent:100*5/13,ndc:3,parts:3,appraisers:2,trials:2}};
 assert.ok(!qualityFlags(s).includes('grr_components_mismatch'));
 assert.ok(qualityFlags({...s,result:{...s.result,grr:6}}).includes('grr_components_mismatch'));
 assert.ok(qualityFlags({...s,result:{...s.result,gageRRPercent:5}}).includes('grr_percent_mismatch'));
});
test('private API: authentication, CSRF, expiry, scope, read-only and safe audit',async t=>{
 const folder=mkdtempSync(join(tmpdir(),'ajtool-analytics-test-'));let now=Date.now();
 const reserve=createServer();reserve.listen(0,'127.0.0.1');await new Promise(resolve=>reserve.once('listening',resolve));const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
 const sources=[];
 const app=createAnalyticsApp({sources,bootstrap:'synthetic-one-use-capability',auditFile:join(folder,'audit.jsonl'),port,now:()=>now});
 const server=app.listen(port,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const headers={origin:base,'content-type':'application/json'};
 const call=(path,body,cookie,extra={})=>fetch(base+path,{method:body?'POST':'GET',headers:{...headers,...cookie?{cookie}:{},...extra},...body?{body:JSON.stringify(body)}:{}});
 t.after(()=>{server.closeAllConnections();server.close();rmSync(folder,{recursive:true,force:true});});
 await t.test('anonymous cannot read metrics',async()=>assert.equal((await call('/api/query',{})).status,401));
 await t.test('wrong capability cannot obtain a session',async()=>assert.equal((await call('/session/bootstrap',{capability:'wrong'})).status,401));
 const session=await call('/session/bootstrap',{capability:'synthetic-one-use-capability'});assert.equal(session.status,200);const cookie=session.headers.get('set-cookie').split(';')[0];
 await t.test('cookie is HttpOnly and SameSite Strict',()=>assert.match(session.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/));
 await t.test('bootstrap is one use',async()=>assert.equal((await call('/session/bootstrap',{capability:'synthetic-one-use-capability'})).status,401));
 await t.test('foreign origin is denied even with cookie',async()=>assert.equal((await call('/api/query',{},cookie,{origin:'https://attacker.invalid'})).status,403));
 await t.test('forged plant is denied server-side',async()=>assert.equal((await call('/api/query',{plant:'not-authorized'},cookie)).status,403));
 await t.test('no operational mutation API exists',async()=>assert.equal((await call('/api/studies',{value:1},cookie)).status,405));
 await t.test('query returns truthful empty result, not sample fallback',async()=>{const r=await call('/api/query',{q:'DO_NOT_LOG_ENTITY'},cookie);assert.equal(r.status,200);assert.deepEqual((await r.json()).sources,[]);});
 await t.test('audit omits search values and capability',()=>{const log=readFileSync(join(folder,'audit.jsonl'),'utf8');assert.ok(!log.includes('DO_NOT_LOG_ENTITY'));assert.ok(!log.includes('synthetic-one-use-capability'));});
 await t.test('database failure is sanitized and never returns fallback metrics',async()=>{
  sources.push({id:'cpk',tool:'calculate_cpk_ppk',pool:{connect:async()=>{throw new Error('DO_NOT_RETURN_DB_DETAIL');}}});
  try{const r=await call('/api/query',{},cookie);assert.equal(r.status,503);const body=await r.text();assert.ok(!body.includes('DO_NOT_RETURN_DB_DETAIL'));assert.ok(!body.includes('sources'));assert.ok(!readFileSync(join(folder,'audit.jsonl'),'utf8').includes('DO_NOT_RETURN_DB_DETAIL'));}finally{sources.pop();}
 });
 await t.test('expired session is denied',async()=>{now+=2*60*60*1000+1;assert.equal((await call('/api/session',null,cookie)).status,401);});
 await t.test('logout clears the private cookie',async()=>{const r=await call('/session/logout',{},cookie);assert.equal(r.status,200);assert.match(r.headers.get('set-cookie'),/Expires=Thu, 01 Jan 1970/);});
});
