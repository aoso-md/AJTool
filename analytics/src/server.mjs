import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createAnalyticsApp} from './app.mjs';
if(process.env.ANALYTICS_MODE!=='local-synthetic')throw new Error('Only isolated local synthetic mode is implemented; remote deployment is disabled');
const sources=[];
for(const [id,tool,database,servicePort] of [['cpk','calculate_cpk_ppk','ajtool_cpk',8108],['msa','run_msa_analysis','ajtool_msa',8109]]){
 const connectionString=process.env[id.toUpperCase()+'_DATABASE_URL'];const u=new URL(connectionString);
 if(u.hostname!=='db'||u.pathname!=='/'+database||u.username!=='ajtool_local_analytics_reader')throw new Error('Unapproved analytics database target');
 const pool=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:2000,query_timeout:3000});pool.on('error',()=>{});
 const r=await pool.query("SELECT current_setting('default_transaction_read_only') AS ro,has_table_privilege(current_user,'public.studies','SELECT') AS raw,has_table_privilege(current_user,'ajtool_analytics.studies','SELECT') AS minimized");
 if(r.rows[0].ro!=='on'||r.rows[0].raw||!r.rows[0].minimized)throw new Error('Analytics reader privilege contract failed');
 sources.push({id,tool,pool,readyUrl:`http://${id}:${servicePort}/ready`});
}
const bootstrap=randomBytes(32).toString('hex');const port=30110;
writeFileSync('/private/access.json',JSON.stringify({url:`http://127.0.0.1:${port}/#access=${bootstrap}`,expiresAfterMinutes:5,scope:'local synthetic read only'}),{mode:0o600});
const app=createAnalyticsApp({sources,bootstrap,port,auditFile:'/private/query-audit.jsonl',uiPath:fileURLToPath(new URL('../web/dist/',import.meta.url))});
const server=app.listen(port,'0.0.0.0',()=>console.log('Private local synthetic analytics ready on loopback port 30110; access capability stays in the private local file.'));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(async()=>{await Promise.all(sources.map(s=>s.pool.end()));process.exit(0);}));
