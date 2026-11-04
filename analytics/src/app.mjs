import express from 'express';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import {appendFileSync} from 'node:fs';
import {parseFilters,readSource} from './queries.mjs';
import {qualityLabels} from './quality.mjs';
const hash=s=>createHash('sha256').update(s).digest('hex');
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&timingSafeEqual(Buffer.from(hash(a)),Buffer.from(hash(b)));
export function createAnalyticsApp({sources,bootstrap,auditFile,uiPath,port=30110,now=()=>Date.now()}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
 const sessions=new Map();let available=true;const bootUntil=now()+5*60*1000;
 function audit(event){appendFileSync(auditFile,JSON.stringify({atUtc:new Date(now()).toISOString(),...event})+'\n',{mode:0o600});}
 const origins=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
 app.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'none'"});
  if(!origins.has('http://'+req.headers.host))return res.status(403).json({error:'host_denied'});
  if(req.headers.origin&&!origins.has(req.headers.origin))return res.status(403).json({error:'origin_denied'});
  next();
 });
 app.use(express.json({limit:'8kb'}));
 app.get('/health',(_req,res)=>res.json({status:'ok',service:'quality-intelligence',scope:'local-synthetic'}));
 app.post('/session/bootstrap',(req,res)=>{
  if(!req.headers.origin)return res.status(403).json({error:'origin_required'});
  if(!available||now()>bootUntil||!equal(req.body?.capability,bootstrap)){audit({action:'session',decision:'denied'});return res.status(401).json({error:'access_denied'});}
  available=false;const token=randomBytes(32).toString('hex');const until=now()+2*60*60*1000;
  sessions.set(hash(token),{until,scope:'synthetic-unassigned',role:'analytics_readonly'});
  res.cookie('ajtool_analytics',token,{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:2*60*60*1000});
  audit({action:'session',decision:'local_readonly_granted'});res.json({authorized:true,expiresAt:new Date(until).toISOString()});
 });
 app.post('/session/logout',(req,res)=>{
  if(!req.headers.origin)return res.status(403).json({error:'origin_required'});
  const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ajtool_analytics='))?.split('=')[1];
  if(token)sessions.delete(hash(token));res.clearCookie('ajtool_analytics',{httpOnly:true,sameSite:'strict',path:'/'});
  audit({action:'session',decision:'closed'});res.json({authorized:false});
 });
 app.use('/api',(req,res,next)=>{
  const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('ajtool_analytics='))?.split('=')[1];
  const session=cookie?sessions.get(hash(cookie)):undefined;
  if(!session||session.until<=now()){if(cookie)sessions.delete(hash(cookie));audit({action:'api',decision:'unauthorized'});return res.status(401).json({error:'private_access_required'});}
  req.analyticsSession=session;next();
 });
 app.get('/api/session',(req,res)=>res.json({authorized:true,role:req.analyticsSession.role,scope:'Staging sintético sin planta documentada',confidentialDataAuthorized:false}));
 app.post('/api/query',async(req,res)=>{
  const start=performance.now();
  if(!req.headers.origin)return res.status(403).json({error:'origin_required'});
  let f;try{f=parseFilters(req.body);}catch(e){audit({action:'query',decision:e.status===403?'scope_denied':'invalid_filter'});return res.status(e.status||400).json({error:e.message});}
  try{
   const selected=sources.filter(s=>f.tool==='all'||s.id===f.tool);
   const data=await Promise.all(selected.map(async source=>{
    const result=await readSource(source.pool,source,f);
    try{
     const r=await fetch(source.readyUrl,{signal:AbortSignal.timeout(1200),redirect:'error'});const doc=await r.json();
     result.integration={observed:true,ready:r.ok&&doc.status==='ready',persistence:doc.persistence?.tier||'unknown',durable:doc.persistence?.durable===true,publish:doc.publish,polling:doc.poller?.enabled===true,lastSuccessAt:doc.poller?.lastSuccessAt||null};
    }catch{result.integration={observed:false,ready:null,persistence:'unknown',durable:null,publish:null,polling:null,lastSuccessAt:null};}
    return result;
   }));
   const rowCount=data.reduce((n,x)=>n+x.rows.length,0);const elapsedMs=Math.round(performance.now()-start);
   audit({action:'query',decision:'allowed',view:f.view,sourceCount:data.length,returnedRows:rowCount,elapsedMs,scope:'synthetic-unassigned'});
   res.json({asOf:new Date(now()).toISOString(),classification:'synthetic-local',filters:f,sources:data,qualityLabels,
    definitions:{registered:'COUNT de studies; identidad (fuente,tool,id). Sin sumar reintentos de inbox/outbox.',completed:'status=completed',pending:'status=pending',invalid:'status IN (skipped,error)',daily:'Estudios creados por día UTC; no tendencia de capacidad.',grr:'100 × GRR / TV; % de variación del estudio, distinto a contribución de varianza.',reliabilityScope:'Fechas UTC y planta autorizada; no aplica búsqueda/estado de estudios.',duplicateAttempts:'No hay contador durable de todos los reintentos duplicados; no disponible.'},elapsedMs});
  }catch{
   audit({action:'query',decision:'source_unavailable',view:f.view});res.status(503).json({error:'source_unavailable',message:'No se pudo consultar PostgreSQL. No se muestran cifras de memoria o de ejemplo.'});
  }
 });
 app.use('/api',(_req,res)=>res.status(405).json({error:'read_only_api'}));
 app.use('/session',(_req,res)=>res.status(404).json({error:'not_found'}));
 if(uiPath)app.use(express.static(uiPath,{dotfiles:'deny',index:'index.html',setHeaders:r=>r.set('Cache-Control','no-store')}));
 app.use((err,_req,res,_next)=>res.status(err.type==='entity.too.large'?413:400).json({error:'invalid_request'}));
 return app;
}
