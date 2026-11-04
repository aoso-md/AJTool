"""Read/backup known synthetic staging; restart only the explicitly named local compose."""
from pathlib import Path
import json, subprocess, urllib.request, hashlib, time, sys, os
ROOT=Path(__file__).resolve().parents[2]
OUT=(ROOT/os.environ.get('AJTOOL_RC_EVIDENCE','artifacts/final-rc-20261028')).resolve()
assert OUT.is_relative_to((ROOT/'artifacts').resolve()),'Evidence must stay within workspace artifacts'
COMPOSE=['docker','compose','-f',str(ROOT/'deploy/product-polish/compose.yml')]
DB='ajtool-polish-local-20261027-db-1'
IDS={'cpk':{'848fde96-59ff-4387-99a5-79967b1be68b','4cd21274-b298-4ae7-8ef8-76bb62414ef4'},'msa':{'5532bafe-7e57-48da-9a59-2474647e76c3','6089bd59-8c33-4d81-bc82-8599820fda87'}}
def run(args):return subprocess.check_output(args,cwd=ROOT)
def get(port,path):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}{path}',timeout=8) as response:return json.load(response)
def snapshot():
    result={}
    for tag,port in [('cpk',30108),('msa',30109)]:
        ready=get(port,'/ready');status=get(port,'/api/status')
        assert ready['auth']=='open' and ready['persistence']['durable'] and ready['persistence']['tier']=='postgres'
        assert ready['publish']=='shadow' and not ready['poller']['enabled'] and not status['core']['configured']
        studies=get(port,'/api/studies?limit=200')['studies'];assert {s['id'] for s in studies}==IDS[tag], 'Unexpected records: do not restart'
        docs={s['id']:get(port,'/api/studies/'+s['id'])['study'] for s in studies}
        sql="SELECT json_build_object('versions',(SELECT json_agg(version ORDER BY version) FROM schema_migrations),'counts',(SELECT json_object_agg(tab,n) FROM (SELECT 'studies' tab,count(*) n FROM studies UNION ALL SELECT 'event_inbox',count(*) FROM event_inbox UNION ALL SELECT 'event_outbox',count(*) FROM event_outbox UNION ALL SELECT 'manual_commands',count(*) FROM manual_commands) c))"
        meta=json.loads(run(['docker','exec',DB,'psql','-U','ajtool_carlos_local_admin','-d','ajtool_'+tag,'-Atc',sql]))
        result[tag]={'ready':ready,'documents':docs,'database':meta}
    return result
def retained(s):return {tag:{'documents':v['documents'],'database':v['database']} for tag,v in s.items()}
OUT.mkdir(parents=True,exist_ok=True)
mode=sys.argv[1] if len(sys.argv)>1 else 'check'
before=snapshot()
if mode in ['restart','rebuild']:
    assert not (OUT/(mode+'-retention-before.json')).exists(),'Preserve prior run; choose a new evidence directory'
    (OUT/(mode+'-retention-before.json')).write_text(json.dumps(before,indent=2),encoding='utf-8')
    for tag in IDS:
        data=run(['docker','exec',DB,'pg_dump','-U','ajtool_carlos_local_admin','-d','ajtool_'+tag,'-Fc','--no-owner','--no-acl'])
        (OUT/(tag+'-synthetic-backup.dump')).write_bytes(data)
        # Archive is synthetic only.
        # Validate custom archive using a pipe, without restoring over an existing database.
        p=subprocess.run(['docker','exec','-i',DB,'pg_restore','--list'],input=data,capture_output=True,check=True)
        (OUT/(tag+'-backup-toc.txt')).write_bytes(p.stdout)
    run(COMPOSE+['restart','db'])
    for _ in range(60):
        try:
            assert run(['docker','exec',DB,'pg_isready','-U','ajtool_carlos_local_admin','-d','ajtool_msa']);break
        except Exception:time.sleep(1)
    run(COMPOSE+(['up','-d','--no-deps','cpk','msa'] if mode=='rebuild' else ['restart','cpk','msa']))
    for attempt in range(60):
        try:after=snapshot();break
        except Exception:
            if attempt==59:raise
            time.sleep(1)
    assert retained(before)==retained(after),'Exact document or durable ledger counts changed'
    (OUT/(mode+'-retention-after.json')).write_text(json.dumps(after,indent=2),encoding='utf-8')
else:after=before
report={'status':'PASS','mode':mode,'checkedAtUtc':__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(),'scope':'existing isolated local synthetic staging only','fourKnownStudies':True,'exactRetention':mode in ['restart','rebuild'],'postgresRebooted':mode in ['restart','rebuild'],'appsRebooted':mode in ['restart','rebuild'],'liveEventsSent':False,'backupArchiveReadable':mode in ['restart','rebuild'],'restoreExecuted':False,'documentsSha256':hashlib.sha256(json.dumps(retained(after),sort_keys=True).encode()).hexdigest()}
(OUT/('integrity-'+mode+'.json')).write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps(report))
