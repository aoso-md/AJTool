import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prepare,fixture,quiet} from './helpers/isolated-postgres.mjs';
import {startFakeCore,producedEvent} from '../../tools/calculate-cpk-ppk/test/helpers/fake-core.js';

const observations = [
  ['P1','A',1,10.01],['P1','A',2,10.011],['P1','B',1,10.012],['P1','B',2,10.013],
  ['P2','A',1,10.2],['P2','A',2,10.201],['P2','B',1,10.202],['P2','B',2,10.203]
].map(([partId,operatorId,trial,value])=>({partId,operatorId,trial,value}));

for (const service of ['calculate-cpk-ppk','run-msa-analysis']) test(`${service}: durable domain, commands and delivery`,async t=>{
  const f=await fixture(service,prepare());
  const {TOOL,...domainModule}=await import(`../../tools/${service}/src/tool.js`);
  const {createCoreClient}=await import(`../../tools/${service}/src/platform/core-client.js`);
  const {createPublisher,createPoller}=await import(`../../tools/${service}/src/platform/poller.js`);
  const {createOutboxWorker}=await import(`../../tools/${service}/src/platform/outbox-worker.js`);
  const {createApp}=await import(`../../tools/${service}/src/platform/app.js`);
  const {fromCore}=await import(`../../tools/${service}/src/platform/ies.js`);
  const {digest,inboxEvent}=await import(`../../tools/${service}/src/platform/reliability.js`);
  const fake=await startFakeCore({consumes:{[TOOL.id]:TOOL.consumes}});
  const core=createCoreClient({baseUrl:fake.url,apiKey:fake.key});
  const publisher=createPublisher({core,mode:'live',log:quiet});
  const factory=domainModule.createCapabilityTool || domainModule.createMsaTool;
  const domain=factory({store:f.store,core,publisher,log:quiet});
  const poller=createPoller({toolId:TOOL.id,consumes:TOOL.consumes,core,store:f.store,processEvent:domain.processEvent,beforeTick:domain.beforeTick,log:quiet});
  const app=createApp({tool:TOOL,config:{},core,store:f.store,poller,publisher,registerRoutes:domain.registerRoutes,log:quiet});
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  const base=`http://127.0.0.1:${server.address().port}`;
  async function post(path,body,key) { const r=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(key?{'idempotency-key':key}:{})},body:JSON.stringify(body)});return {status:r.status,body:await r.json()}; }
  async function stage(mode='live') {
    const id=randomUUID();const envelope=producedEvent({type:TOOL.produces[0],moduleId:TOOL.id,data:{studyId:id}});
    await f.store.processEventTransaction({tool:TOOL.id,consumer:'worker-test',event:{eventId:id,rawInput:{},canonicalInput:{},inputHash:digest({})},handler:tx=>tx.stageOutbox({eventId:envelope.event_id,publicationKey:id,destinationId:'core_api',envelopeText:JSON.stringify(envelope),mode})});
    return f.store.getOutboxRecord(TOOL.id,envelope.event_id);
  }
  try {
    await f.store.ensureRuntimeIdentity({tool:TOOL.id,publishMode:'live'});
    await t.test('runtime mode cannot be switched by an environment change',async()=>{
      await assert.rejects(f.store.ensureRuntimeIdentity({tool:TOOL.id,publishMode:'shadow'}),/identity mismatch/);
      assert.equal((await f.store.getRuntimeIdentity(TOOL.id)).publishMode,'live');
    });
    await t.test('domain and cursor commit atomically without HTTP publication',async()=>{
      await poller.tick(); // cold-start at tip
      if(service==='calculate-cpk-ppk') fake.seed(producedEvent({type:'PRODUCT_SPEC_UPDATED',moduleId:'manage_product_specs',data:{partId:'PART',characteristics:[{id:'D',lsl:9.95,usl:10.05,version:'REV-2'}]}}));
      const incoming=producedEvent({type:TOOL.consumes[0],moduleId:service==='calculate-cpk-ppk'?'collect_quality_measurements':'manage_device_registry',data:service==='calculate-cpk-ppk'?{partId:'PART',characteristicId:'D',measurements:[10,10.08,10,10.08]}:{operation:'register',gaugeId:'G-1'}});
      const row=fake.seed(incoming);
      await poller.tick();
      assert.equal(fake.posted.length,0,'HTTP must happen only in worker');
      const inbox=await f.store.getInboxRecord(TOOL.id,incoming.event_id);
      assert.equal(inbox.outcome,'processed');
      assert.equal(String(await f.store.getCursor(`subscription:${TOOL.id}`)),String(row.seq));
      const study=await f.store.getStudy(inbox.studyId);
      if(service==='calculate-cpk-ppk') {assert.equal(study.spec.version,'REV-2');assert.equal(study.publish.state,'pending');}
      else {
        assert.equal(study.status,'pending');
        const path=`/api/studies/${study.id}/capture`;
        const [a,b]=await Promise.all([post(path,{observations},'capture-1'),post(path,{observations},'capture-1')]);
        assert.equal(a.status,200);assert.deepEqual(a,b);
        assert.equal((await post(path,{observations:observations.slice(1)},'capture-1')).status,409);
        assert.equal(fake.posted.length,0);
      }
      const worker=createOutboxWorker({store:f.store,toolId:TOOL.id,core,mode:'live'});
      await worker.tick();assert.equal(fake.posted.length,1);
      const delivered=fake.posted[0];
      assert.equal(delivered.causation_id,incoming.event_id);assert.equal(delivered.correlation_id,incoming.correlation_id);
      assert.equal((await f.store.getOutboxRecord(TOOL.id,delivered.event_id)).state,'delivered');
      await domain.processEvent(fromCore(row));
      assert.equal((await f.store.listStudies(TOOL.id,200)).length,1);
      if(service==='run-msa-analysis') assert.equal(delivered.data.verdict,'acceptable');
    });
    await t.test('manual create commands replay and conflict instead of duplicating studies',async()=>{
      const body=service==='run-msa-analysis'?{gaugeId:'MANUAL',observations}:{partId:'MANUAL',characteristicId:'D',lsl:9,usl:11,measurements:[10,10.01,10,10.01]};
      const a=await post('/api/studies',body,'create-1');const b=await post('/api/studies',body,'create-1');
      assert.equal(a.status,201);assert.deepEqual(a,b);
      assert.equal((await post('/api/studies',{...body,notes:'different'},'create-1')).status,409);
    });
    await t.test('bad source is auditable and a content conflict stops cursor progress',async()=>{
      const event=fromCore({...producedEvent({type:TOOL.consumes[0],moduleId:'wrong-source',data:{}}),seq:'9007199254740993'});
      const cursor={name:'rejection',expectedSeq:null,targetSeq:event.seq};
      const result=await domain.processEvent(event,{cursor});assert.equal(result.outcome,'rejected');
      assert.equal(await f.store.getCursor('rejection'),'9007199254740993');
      const conflict=await domain.processEvent({...event,seq:'9007199254740994',data:{different:true}},{cursor:{name:'rejection',targetSeq:'9007199254740994'}});
      assert.equal(conflict.status,'conflict');assert.equal(await f.store.getCursor('rejection'),'9007199254740993');
    });
    await t.test('bounded SQL retry and lost COMMIT acknowledgement preserve one decision',async()=>{
      const event=fromCore({...producedEvent({type:TOOL.consumes[0],data:{}}),seq:1});let calls=0;
      const args={tool:TOOL.id,consumer:'ack',event:inboxEvent(event),cursor:{name:'ack',targetSeq:'1'},handler:async tx=>{
        if(++calls===1) throw Object.assign(new Error('serialization'),{code:'40001'});
        const query=tx.client.query.bind(tx.client);
        tx.client.query=async (...args)=>{const result=await query(...args);if(args[0]==='COMMIT')throw Object.assign(new Error('lost commit acknowledgement'),{code:'ECONNRESET'});return result;};
      }};
      await assert.rejects(f.store.processEventTransaction(args));assert.equal(calls,2);
      const replay=await f.store.processEventTransaction({...args,handler:()=>assert.fail('Must not repeat committed business work')});
      assert.equal(replay.status,'replay');assert.equal(await f.store.getCursor('ack'),1);
    });
    await t.test('shadow bytes remain isolated even when worker runs live',async()=>{
      const row=await stage('shadow');const worker=createOutboxWorker({store:f.store,toolId:TOOL.id,core,mode:'live'});
      assert.equal(await worker.tick(),false);assert.equal((await f.store.getOutboxRecord(TOOL.id,row.eventId)).state,'shadow_recorded');
    });
    await t.test('authorization, rate limit, timeout, 5xx and invalid outcomes are durable',async()=>{
      for(const [status,kind] of [[401,'auth'],[403,'auth'],[429,'retryable'],[500,'retryable'],[null,'retryable'],[422,'invalid']]) {
        const row=await stage();const failure=Object.assign(new Error('sensitive-remote-body-must-not-persist'),{status,kind,retryAfterMs:status===429?120000:null});
        const worker=createOutboxWorker({store:f.store,toolId:TOOL.id,core:{configured:true,publishText:async()=>{throw failure;}},mode:'live'});
        await worker.tick();const failed=await f.store.getOutboxRecord(TOOL.id,row.eventId);
        assert.equal(failed.state,kind==='auth'?'blocked_auth':kind==='invalid'?'quarantined':'retry_wait');
        if(status===429) assert.ok(new Date(failed.nextAttemptAt).getTime()>Date.now()+110000);
        assert.equal((await f.pool.query('SELECT count(*) FROM public.outbox_attempts WHERE outbox_id=$1 AND finished_at IS NOT NULL',[row.outboxId])).rows[0].count,'1');
        if(kind==='auth'||kind==='invalid') {
          const recovery=await post(`/api/outbox/${row.outboxId}/recover`,{reason:'Synthetic credential or destination repair'});assert.equal(recovery.status,200);
        } else await f.ownerPool.query("UPDATE public.event_outbox SET next_attempt_at=now() WHERE outbox_id=$1",[row.outboxId]);
        const success=createOutboxWorker({store:f.store,toolId:TOOL.id,core,mode:'live'});await success.tick();
        assert.equal((await f.store.getOutboxRecord(TOOL.id,row.eventId)).state,'delivered');
        assert.equal(JSON.stringify(fake.posted.at(-1)),row.envelopeText);
      }
    });
    await t.test('expired lease can be reclaimed and fences stale acknowledgements',async()=>{
      const row=await stage();const a=createOutboxWorker({store:f.store,toolId:TOOL.id,core,mode:'live'});const first=await a.claim();
      assert.equal(first.outbox_id,String(row.outboxId));
      assert.equal(await a.claim(),null);
      await f.ownerPool.query("UPDATE public.event_outbox SET lease_until=now()-interval '1 second' WHERE outbox_id=$1",[row.outboxId]);
      const b=createOutboxWorker({store:f.store,toolId:TOOL.id,core,mode:'live'});const second=await b.claim();
      assert.notEqual(first.lease_token,second.lease_token);
      assert.equal(await a.finish(first,{state:'delivered',outcome:'published'}),false);
      await core.publishText(second.envelope_text);assert.equal(await b.finish(second,{state:'delivered',outcome:'published',httpStatus:201}),true);
      const attempts=(await f.pool.query('SELECT outcome FROM public.outbox_attempts WHERE outbox_id=$1 ORDER BY attempt_no',[row.outboxId])).rows;
      assert.deepEqual(attempts.map(a=>a.outcome),['lease_expired','published']);
    });
  } finally {await new Promise(resolve=>server.close(resolve));await fake.close();await f.close();}
});
