import { digest } from './reliability.js';
import { randomUUID } from 'node:crypto';

// This worker never receives a database connection while performing HTTP.
export function createOutboxWorker ({ store, toolId, core, mode = 'shadow', destinationId = 'core_api', leaseMs = 30000, intervalMs = 1000, maxAttempts = 8, log = console }) {
  let timer; let active; let stopped = true;
  const status = { state: 'stopped', delivered: 0, lastError: null };
  async function claim () {
    if (!store.transactional || mode !== 'live' || !core.configured) return null;
    return store.executeTransaction(async (client) => {
      const row = (await client.query(`SELECT o.* FROM public.event_outbox o
        JOIN public.runtime_identity r ON r.tool=o.tool AND r.publish_mode='live'
        LEFT JOIN public.delivery_gates g ON g.tool=o.tool AND g.destination=o.destination_id
        WHERE o.tool=$1 AND o.destination_id=$2 AND o.mode='live'
          AND (g.state IS NULL OR g.state='closed')
          AND ((o.state IN ('pending','retry_wait') AND (o.next_attempt_at IS NULL OR o.next_attempt_at<=now()))
            OR (o.state='delivering' AND o.lease_until<=now()))
        ORDER BY o.outbox_id FOR UPDATE OF o SKIP LOCKED LIMIT 1`, [toolId,destinationId])).rows[0];
      if (!row) return null;
      await client.query(`UPDATE public.outbox_attempts SET finished_at=now(), outcome='lease_expired', error_class='unknown_after_crash'
        WHERE outbox_id=$1 AND finished_at IS NULL`, [row.outbox_id]);
      const token = randomUUID();
      const claimed = (await client.query(`UPDATE public.event_outbox SET state='delivering', lease_token=$2,
        lease_until=now()+$3*interval '1 millisecond', attempts=attempts+1 WHERE outbox_id=$1 RETURNING *`,[row.outbox_id,token,leaseMs])).rows[0];
      await client.query('INSERT INTO public.outbox_attempts(outbox_id,attempt_no,lease_token) VALUES($1,$2,$3)',[row.outbox_id,claimed.attempts,token]);
      return claimed;
    });
  }
  async function finish (row, { state, outcome, httpStatus = null, errorClass = null, retryMs = null, seq = null }) {
    return store.executeTransaction(async (client) => {
      const current = (await client.query(`SELECT outbox_id FROM public.event_outbox WHERE outbox_id=$1 AND lease_token=$2
        AND state='delivering' AND lease_until>now() FOR UPDATE`,[row.outbox_id,row.lease_token])).rows[0];
      if (!current) return false; // expired or fenced: cannot acknowledge another worker's claim
      await client.query(`UPDATE public.outbox_attempts SET finished_at=now(),outcome=$3,http_status=$4,error_class=$5,retry_after_seconds=$6
        WHERE outbox_id=$1 AND lease_token=$2 AND finished_at IS NULL`,[row.outbox_id,row.lease_token,outcome,httpStatus,errorClass,retryMs == null ? null : Math.ceil(retryMs/1000)]);
      await client.query(`UPDATE public.event_outbox SET state=$3,lease_token=NULL,lease_until=NULL,
        delivered_at=CASE WHEN $3='delivered' THEN now() ELSE delivered_at END,
        next_attempt_at=CASE WHEN $4::double precision IS NULL THEN NULL ELSE now()+$4*interval '1 millisecond' END,
        last_error_class=$5,last_error_detail=$5 WHERE outbox_id=$1 AND lease_token=$2`,[row.outbox_id,row.lease_token,state,retryMs,errorClass]);
      if (row.study_id) await client.query(`UPDATE public.studies SET updated_at=now(),
        doc=jsonb_set(doc,'{publish}',coalesce(doc->'publish','{}'::jsonb) || jsonb_build_object('state',$4::text,'at',now(),'seq',$5::text))
        WHERE tool=$1 AND id=$2 AND doc #>> '{publish,eventId}'=$3`,
        [toolId,row.study_id,row.event_id,state==='delivered'?(outcome==='duplicate'?'duplicate':'published'):state,seq==null?null:String(seq)]);
      if (state==='blocked_auth') await client.query(`INSERT INTO public.delivery_gates(tool,destination,state,reason)
        VALUES($1,$2,'open','authorization_failed') ON CONFLICT(tool,destination) DO UPDATE SET state='open',reason='authorization_failed',updated_at=now()`,[toolId,destinationId]);
      return true;
    });
  }
  async function tick () {
    const row = await claim();
    if (!row) return false;
    try {
      const result = await core.publishText(row.envelope_text);
      if (await finish(row,{ state:'delivered',outcome:result.outcome,httpStatus:result.status,seq:result.seq })) status.delivered++;
      status.lastError = null;
    } catch (error) {
      const auth = error.kind==='auth';
      const permanent = error.kind==='invalid' || row.attempts >= maxAttempts;
      const retryMs = auth || permanent ? null : Math.max(0, error.retryAfterMs ?? Math.min(60000,1000 * 2 ** Math.min(row.attempts-1,6)));
      const state = auth ? 'blocked_auth' : permanent ? 'quarantined' : 'retry_wait';
      // Persist only classifications, never remote bodies, API keys or arbitrary exception messages.
      await finish(row,{ state,outcome:state,httpStatus:error.status ?? null,errorClass:auth?'authorization':permanent?'permanent_or_exhausted':'temporary',retryMs });
      status.lastError = state;
    }
    return true;
  }
  async function loop () {
    if (stopped) return;
    status.state='running';
    try { active=tick(); await active; } catch { status.lastError='persistence_unavailable'; log.warn?.('[outbox] persistence unavailable'); }
    finally { active=null; }
    if (!stopped) { timer=setTimeout(loop,intervalMs); timer.unref?.(); }
  }
  return { claim, finish, tick, status:()=>({...status,mode}), start () {
    stopped=false;
    if (!store.transactional || mode!=='live') { status.state='shadow'; return; }
    loop();
  }, async stop () { stopped=true;clearTimeout(timer);if(active) await active.catch(()=>{});status.state='stopped'; } };
}

export function registerOutboxRoutes (api, { store, toolId, requireQuality, actorOf }) {
  if (!store.transactional) return;
  api.get('/outbox', async (req,res) => {
    const rows = await store.executeTransaction(async client => (await client.query(`SELECT outbox_id::text,event_id,study_id,mode,state,attempts,next_attempt_at,lease_until,last_error_class,delivered_at
      FROM public.event_outbox WHERE tool=$1 ORDER BY outbox_id DESC LIMIT 100`,[toolId])).rows);
    res.json({ records:rows });
  });
  api.post('/outbox/:id/recover', requireQuality, async (req,res) => {
    if (!/^\d+$/.test(req.params.id) || typeof req.body?.reason!=='string' || req.body.reason.trim().length<8) return res.status(422).json({error:'reason_required'});
    const actor=actorOf(req.caller);
    const reason=req.body.reason.trim().slice(0,500);
    const result=await store.recordManualCommandTransaction({tool:toolId,commandId:req.get('idempotency-key')?digest({id:req.params.id,actor,key:req.get('idempotency-key')}):randomUUID(),commandType:'outbox_recovery',commandHash:digest({id:req.params.id,actor,reason}),handler:async tx=>{
      const row=(await tx.client.query(`UPDATE public.event_outbox SET state='pending',next_attempt_at=now(),last_error_class=NULL,last_error_detail=NULL
        WHERE tool=$1 AND outbox_id=$2 AND mode='live' AND state IN ('blocked_auth','blocked_destination','quarantined') RETURNING destination_id`,[toolId,req.params.id])).rows[0];
      if (!row) return {status:409,body:{error:'not_recoverable'}};
      await tx.client.query(`UPDATE public.delivery_gates SET state='closed',reason=$3,updated_at=now() WHERE tool=$1 AND destination=$2`,[toolId,row.destination_id,reason]);
      return {status:200,body:{recovered:true,actor,reason,outboxId:req.params.id}};
    }});
    if (!result.ok) return res.status(409).json({error:'idempotency_conflict'});
    res.status(result.result.status).json(result.result.body);
  });
}
