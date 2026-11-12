// Run through stdin only inside the named local staging containers.
// Uses domain handlers, not forged database rows or a live Core connection.
import assert from 'node:assert/strict';
assert.equal(process.env.AJTOOL_ENVIRONMENT,'staging');
assert.equal(process.env.CORE_PUBLISH,'shadow');
assert.equal(process.env.POLL_ENABLED,'false');
assert.equal(process.env.ISOTOOLS_API_URL,'');
assert.equal(new URL(process.env.DATABASE_URL).hostname,'db');
const tag=process.argv[2];assert.ok(['cpk','msa'].includes(tag));
const {createStore}=await import('./src/platform/store.js');
const {fromCore}=await import('./src/platform/ies.js');
const factories=await import('./src/tool.js');
const quiet={info(){},warn(){},error(){}};
const store=await createStore({databaseUrl:process.env.DATABASE_URL,databaseRequired:true,failFast:true,log:quiet});
try{
  const publisher={mode:'shadow',publish(){throw new Error('State fixture must never publish');}};
  const domain=(factories.createCapabilityTool||factories.createMsaTool)({store,core:{configured:false},publisher,log:quiet});
  const id=tag==='cpk'?'d8ac5ed2-3727-4aae-9c50-eaf321a1b265':'16cb73dc-2262-49a8-95bc-30b9be7e657a';
  const event=fromCore({event_id:id,timestamp:'2026-10-27T18:00:00Z',seq:1,platform_version:'1.0',
    module:{id:tag==='cpk'?'collect_quality_measurements':'manage_device_registry',version:'1.0'},
    asset:{asset_id:'DEMO-POLISH-STATE',asset_type:tag==='cpk'?'part':'gauge'},
    event:{type:tag==='cpk'?'MEASUREMENTS_CAPTURED':'NEW_DEVICE_REGISTERED',category:'quality',severity:'info'},
    data:tag==='cpk'?{partId:'DEMO-MISSING-SPEC',characteristicId:'DEMO-NO-LIMITS',measurements:[10,12,10,12]}:{operation:'register',gaugeId:'DEMO-PENDING-MSA',devices:[{id:'DEMO-PENDING-MSA',type:'micrometer'}]},
    metadata:{synthetic:true},correlation_id:id});
  await domain.processEvent(event);
  const study=await store.findStudyByInputEvent(factories.TOOL.id,id);
  assert.equal(study.status,tag==='cpk'?'skipped':'pending');
  console.log(JSON.stringify({tool:tag,studyId:study.id,status:study.status,reason:study.reason,livePublication:false}));
}finally{await store.close();}
