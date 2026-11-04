import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../',import.meta.url)),priv=root+'.env.ajtool-supabase/',ev=root+'artifacts/real-postgres-20261101/';
const db='ajtool-real-restore-20261101',reader='ajtool_local_analytics_reader',name='ajtool-real-staging-dashboard-20261101';
const run=(args,input)=>{const r=spawnSync('docker',args,{input,windowsHide:true,timeout:60000,maxBuffer:4*1024*1024});if(r.status!==0)throw new Error('DASHBOARD_LOCAL_COMMAND_FAILED');return r.stdout.toString().trim();};
const sql=(database,text,user='postgres')=>run(['exec','-i',db,'psql','-X','-At','-v','ON_ERROR_STOP=1','-U',user,'-d',database],Buffer.from(text));
const report={scope:'private local dashboard; only two explicitly whitelisted synthetic acceptance studies in databases cloned from real backup',historicalRecordsExposed:false,remoteMutations:false,views:{}};
try{
 assert.equal(run(['inspect','--format','{{index .Config.Labels "ajtool.real-restore"}}',db]),'true');
 const ids=JSON.parse(readFileSync(priv+'real-staging-synthetic-studies.json','utf8'));for(const id of Object.values(ids))assert.match(id,/^[a-f0-9-]{36}$/);
 const env=priv+'restored-dashboard.env';let password;
 if(existsSync(env)){const line=readFileSync(env,'utf8').split(/\r?\n/).find(x=>x.startsWith('CPK_DATABASE_URL='));password=decodeURIComponent(new URL(line.slice('CPK_DATABASE_URL='.length)).password);}
 else{
  password=randomBytes(32).toString('hex');
  if(sql('postgres',`SELECT count(*) FROM pg_roles WHERE rolname='${reader}'`)==='0')sql('postgres',`CREATE ROLE ${reader} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;`);
  else{assert.equal(sql('postgres',`SELECT count(*) FROM pg_stat_activity WHERE usename='${reader}'`),'0');sql('postgres',`ALTER ROLE ${reader} PASSWORD '${password}';`);}
  sql('postgres',`ALTER ROLE ${reader} SET default_transaction_read_only=on;`);
 }
 for(const tag of ['cpk','msa']){
  let views=readFileSync(root+'analytics/sql/views.sql','utf8');
  views=views.replace(') raw ON true;',`) raw ON true WHERE s.id='${ids[tag]}';`)
   .replace('s.id=i.study_id;', 's.id=i.study_id WHERE s.id IS NOT NULL;')
   .replace('s.tool=o.tool;', 's.tool=o.tool WHERE s.id IS NOT NULL;');
  sql('ajtool_'+tag,views+`\nGRANT CONNECT ON DATABASE ajtool_${tag} TO ${reader}; GRANT USAGE ON SCHEMA public,ajtool_analytics TO ${reader}; GRANT SELECT ON ALL TABLES IN SCHEMA ajtool_analytics TO ${reader};`);
  assert.equal(sql('ajtool_'+tag,"SELECT current_setting('default_transaction_read_only'),has_table_privilege(current_user,'public.studies','SELECT'),has_table_privilege(current_user,'public.studies','INSERT'),has_table_privilege(current_user,'ajtool_analytics.studies','SELECT')",reader),'on|f|f|t');
  assert.equal(sql('ajtool_'+tag,'SELECT count(*) FROM ajtool_analytics.studies',reader),'1');
 }
 if(!existsSync(env))writeFileSync(env,`ANALYTICS_MODE=local-synthetic\nCPK_DATABASE_URL=postgresql://${reader}:${password}@db:5432/ajtool_cpk\nMSA_DATABASE_URL=postgresql://${reader}:${password}@db:5432/ajtool_msa\n`,{flag:'wx',mode:0o600});
 const accessDir=priv+'dashboard-private';mkdirSync(accessDir,{mode:0o700});
 run(['run','-d','--name',name,'--label','ajtool.real-staging=true','--network','ajtool-real-staging-20261101','--env-file',env,'--mount',`type=bind,source=${accessDir},target=/private`,'-p','127.0.0.1:30110:30110','ajtool-private-analytics:20261028']);
 run(['network','connect','ajtool-real-access-20261101',name]);
 const base='http://127.0.0.1:30110';let healthy=false;
 for(let i=0;i<80;i++){try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok){healthy=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(healthy);
 assert.equal((await fetch(base+'/api/session')).status,401);report.anonymousDenied=true;
 const capability=new URL(JSON.parse(readFileSync(accessDir+'/access.json','utf8')).url).hash.slice('#access='.length);
 const session=await fetch(base+'/session/bootstrap',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({capability})});assert.equal(session.status,200);
 const cookie=session.headers.get('set-cookie').split(';')[0];assert.match(session.headers.get('set-cookie'),/HttpOnly/i);
 const query=async body=>fetch(base+'/api/query',{method:'POST',headers:{origin:base,cookie,'content-type':'application/json'},body:JSON.stringify(body)});
 for(const view of ['overview','cpk','msa','reliability','quality']){const response=await query({view});assert.equal(response.status,200);const data=await response.json();const rows=data.sources.reduce((n,s)=>n+s.rows.length,0);assert.equal(rows,['cpk','msa'].includes(view)?1:2);assert.ok(data.sources.every(s=>s.duplicates.extra===0));report.views[view]={http:200,studies:rows,noDuplicateMetrics:true};}
 assert.equal((await query({plant:'unauthorized'})).status,403);report.plantEscalationDenied=true;
 const filtered=await query({q:'AJTOOL-IMPOSSIBLE-FILTER-20261101'});assert.equal((await filtered.json()).sources.reduce((n,s)=>n+s.rows.length,0),0);report.emptyFilterVerified=true;
 const html=await(await fetch(base+'/')).text();assert.ok(!html.includes(password));report.noCredentialInHtml=true;
 report.readerRawSelectDenied=true;report.readerInsertDenied=true;report.httpOnlySession=true;report.status='RESTORED_PRIVATE_DASHBOARD_PASS';report.url=base;
 writeFileSync(ev+'dashboard-acceptance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}catch(error){report.status='DASHBOARD_ACCEPTANCE_BLOCKED';report.reason=/^[A-Z_]+$/.test(error.message)?error.message:'LOCAL_DASHBOARD_ASSERTION_FAILED';writeFileSync(ev+'dashboard-acceptance.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));process.exitCode=2;}
