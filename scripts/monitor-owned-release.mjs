// Passive checks only. No restarts, tokens, study data, email or external alerts.
import {mkdirSync,writeFileSync,appendFileSync,existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
export function assess(name,http,doc){
 if(name==='dashboard')return http===200&&doc.status==='ok'?null:'dashboard_unavailable';
 if(name==='dashboard_anonymous')return http===401?null:'dashboard_access_control_failure';
 if(http!==200)return 'service_unavailable';
 if(doc.persistence?.tier!=='postgres'||doc.persistence?.durable!==true)return 'non_durable_storage';
 if(doc.publish!=='shadow')return 'unexpected_publication_mode';
 return null;
}
if(process.argv.includes('--self-test')){
 assert.equal(assess('cpk',503,{}),'service_unavailable');assert.equal(assess('cpk',200,{persistence:{tier:'memory'}}),'non_durable_storage');assert.equal(assess('dashboard_anonymous',200,{}),'dashboard_access_control_failure');assert.equal(assess('msa',200,{persistence:{tier:'postgres',durable:true},publish:'live'}),'unexpected_publication_mode');
 console.log(JSON.stringify({status:'MONITOR_ALERT_SELF_TEST_PASS',criticalScenariosVerified:4,externalMessagesSent:false}));
}else{
 const folder=new URL('../artifacts/final-execution-20261101/monitor/',import.meta.url);mkdirSync(folder,{recursive:true});
 const state={atUtc:new Date().toISOString(),scope:'local endpoint monitoring only; not a hosted24/7alert service',checks:{},alerts:[]};
 for(const [name,url] of [['cpk','http://127.0.0.1:30128/ready'],['msa','http://127.0.0.1:30129/ready'],['dashboard','http://127.0.0.1:30110/health'],['dashboard_anonymous','http://127.0.0.1:30110/api/session']]){
  let http=0,doc={};try{const r=await fetch(url,{signal:AbortSignal.timeout(5000),redirect:'error'});http=r.status;doc=await r.json();}catch{}
  const alert=assess(name,http,doc);state.checks[name]={http,ok:alert===null};if(alert)state.alerts.push({service:name,reason:alert});
 }
 const stable=JSON.stringify({checks:state.checks,alerts:state.alerts});state.fingerprint=createHash('sha256').update(stable).digest('hex');
 const previous=new URL('current.json',folder);const old=existsSync(previous)?JSON.parse(readFileSync(previous,'utf8')):null;
 if(state.alerts.length&&old?.fingerprint!==state.fingerprint)appendFileSync(new URL('alerts.jsonl',folder),JSON.stringify({atUtc:state.atUtc,alerts:state.alerts})+'\n');
 state.status=state.alerts.length?'OWN_RELEASE_ALERT':'OWN_RELEASE_HEALTHY';writeFileSync(previous,JSON.stringify(state,null,2)+'\n');console.log(JSON.stringify(state));if(state.alerts.length)process.exitCode=2;
}
