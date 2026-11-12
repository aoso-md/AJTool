// Fixed loopback-only acceptance. Reads synthetic records created through the UI.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
const output=root+'artifacts/product-polish-20261027/staging';mkdirSync(output,{recursive:true});
const mode=process.argv[2];assert.ok(['baseline','recover'].includes(mode));
const evidence=[];
for(const [tag,port,identity] of [['cpk',30108,'DEMO-POLISH-CPK'],['msa',30109,'DEMO-POLISH-MSA']]){
  const base=`http://127.0.0.1:${port}`;
  const get=async path=>{const r=await fetch(base+path,{signal:AbortSignal.timeout(5000)});assert.equal(r.status,200);return r.json();};
  const ready=await get('/ready'),status=await get('/api/status');
  assert.equal(ready.auth,'open');assert.equal(ready.persistence.tier,'postgres');assert.equal(ready.persistence.durable,true);
  assert.equal(ready.publish,'shadow');assert.equal(ready.poller.enabled,false);assert.equal(status.core.configured,false);
  const session=await get('/auth/me');assert.equal(session.mode,'open');assert.equal(session.authenticated,false);
  const recordFile=`${output}/${tag}-synthetic-study.json`;
  let study;
  if(mode==='baseline'){
    const list=await get('/api/studies');study=list.studies.find(s=>(s.partId||s.gaugeId)===identity);
    assert.ok(study,'Create the named synthetic study through the local browser first');
    study=(await get('/api/studies/'+encodeURIComponent(study.id))).study;
    writeFileSync(recordFile,JSON.stringify(study,null,2)+'\n');
  }else{
    const previous=JSON.parse(readFileSync(recordFile,'utf8'));
    study=(await get('/api/studies/'+encodeURIComponent(previous.id))).study;
    assert.deepEqual(study,previous,'Exact retained record must survive restart');
  }
  assert.equal(study.status,'completed');
  if(tag==='cpk'){
    assert.ok(Math.abs(study.result.cpk-1.128)<1e-10);
    // The existing engine retains these indices at four decimal places.
    assert.ok(Math.abs(study.result.ppk-Math.sqrt(3))<1e-4);
    assert.equal(study.input.measurements.length,4);
  }else{
    assert.equal(study.input.observations.length,12);
    assert.equal(study.result.appraisers,2);assert.equal(study.result.trials,2);assert.equal(study.result.parts,3);
    for(const key of ['repeatability','reproducibility','partVariation','totalVariation','gageRRPercent','ndc']) assert.ok(Number.isFinite(study.result[key]),key);
  }
  const publicPaths=['/health','/ready','/auth/me','/api/status','/.env','/api/config'];
  const privateEnv=readFileSync(root+`.env.product-polish/${tag}.env`,'utf8');
  const databaseUrl=privateEnv.match(/^DATABASE_URL=(.+)$/m)[1];
  const password=new URL(databaseUrl).password;
  const publicChecks=[];
  for(const path of publicPaths){
    const response=await fetch(base+path,{signal:AbortSignal.timeout(5000)}),body=await response.text();
    assert.ok(!body.includes(databaseUrl)&&!body.includes(password),'No credential disclosure');
    assert.ok(!/postgres(?:ql)?:\/\//i.test(body),'No database connection strings');
    publicChecks.push({path,status:response.status,credentialDisclosure:false});
  }
  evidence.push({tag,mode,checkedAtUtc:new Date().toISOString(),auth:'open',postgresDurable:true,coreConfigured:false,publish:'shadow',polling:false,studyId:study.id,documentSha256:createHash('sha256').update(JSON.stringify(study)).digest('hex'),publicChecks,
    confidentialityBoundary:'Open-mode study APIs are accessible without login. This isolated staging contains synthetic data only; this test does not establish authorization for confidential production data.'});
}
writeFileSync(`${output}/${mode}.json`,JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence.map(({publicChecks,confidentialityBoundary,...summary})=>summary),null,2));
