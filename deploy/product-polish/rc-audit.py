"""Evidence inventory with no environment values or industrial records."""
from pathlib import Path
import subprocess,json,hashlib,datetime
ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'artifacts/final-rc-20261028'
def run(args):return subprocess.check_output(args,cwd=ROOT)
def digest(data):return hashlib.sha256(data).hexdigest()
results=[]
for source,container in [('tools/calculate-cpk-ppk','ajtool-polish-local-20261027-cpk-1'),('tools/run-msa-analysis','ajtool-polish-local-20261027-msa-1'),('analytics','ajtool-analytics-local-20261028-dashboard-1')]:
    files=[p for folder in ['src','web/dist'] for p in (ROOT/source/folder).rglob('*') if p.is_file()]
    paths=['/app/'+p.relative_to(ROOT/source).as_posix() for p in files]
    actual={line.split('  ',1)[1]:line.split('  ',1)[0] for line in run(['docker','exec',container,'find','/app/src','/app/web/dist','-type','f','-exec','sha256sum','{}','+']).decode().splitlines()}
    comparisons=[{'path':p.relative_to(ROOT).as_posix(),'sha256':digest(p.read_bytes()),'matchesContainer':digest(p.read_bytes())==actual.get(inside)} for p,inside in zip(files,paths)]
    image=run(['docker','inspect','--format','{{.Image}}',container]).decode().strip()
    results.append({'source':source,'container':container,'imageId':image,'sourceMatches':all(x['matchesContainer'] for x in comparisons if '/src/' in x['path']),'allMatch':all(x['matchesContainer'] for x in comparisons),'containerFiles':actual,'files':comparisons})
roles={}
for tag in ['cpk','msa']:
    role='ajtool_local_analytics_reader'
    sql="""SELECT json_build_object(
    'role',(SELECT row_to_json(r) FROM (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls,rolconfig FROM pg_roles WHERE rolname='ajtool_local_analytics_reader') r),
    'memberships',(SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname='ajtool_local_analytics_reader'),
    'tables',(SELECT json_agg(row_to_json(t)) FROM (SELECT n.nspname AS schema,c.relname AS name,pg_get_userbyid(c.relowner) AS owner,has_table_privilege('ajtool_local_analytics_reader',c.oid,'SELECT') AS can_select,has_table_privilege('ajtool_local_analytics_reader',c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS can_mutate FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','ajtool_analytics') AND c.relkind IN ('r','v')) t),
    'create_public',has_schema_privilege('ajtool_local_analytics_reader','public','CREATE'),
    'create_analytics',has_schema_privilege('ajtool_local_analytics_reader','ajtool_analytics','CREATE'),
    'create_database',has_database_privilege('ajtool_local_analytics_reader',current_database(),'CREATE'),
    'create_temp',has_database_privilege('ajtool_local_analytics_reader',current_database(),'TEMP'),
    'writable_columns',(SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('public','ajtool_analytics') AND a.attnum>0 AND NOT a.attisdropped AND c.relkind IN ('r','v') AND has_column_privilege('ajtool_local_analytics_reader',c.oid,a.attnum,'INSERT,UPDATE,REFERENCES')))"""
    data=json.loads(run(['docker','exec','ajtool-polish-local-20261027-db-1','psql','-U','ajtool_carlos_local_admin','-d','ajtool_'+tag,'-Atc',sql]))
    assert not any(t['can_mutate'] for t in data['tables']);assert not data['memberships']
    assert not any(data[k] for k in ['create_public','create_analytics','create_database','create_temp','writable_columns'])
    assert not any(data['role'][flag] for flag in ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])
    roles[tag]=data
report={'checkedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'branch':run(['git','branch','--show-current']).decode().strip(),'baseHead':run(['git','rev-parse','HEAD']).decode().strip(),'containers':results,'readerEffectivePrivileges':roles,'remoteRevisionAttested':False}
(OUT/'as-built-inventory.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
print(json.dumps({'imagesAndSourceMatch':{r['source']:r['allMatch'] for r in results},'readerZeroMutation':True,'remoteRevisionAttested':False}))
