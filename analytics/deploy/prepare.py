"""Provision real read-only credentials/views in the EXISTING synthetic PostgreSQL only."""
from pathlib import Path
import subprocess,json,secrets,sys
root=Path(__file__).resolve().parents[2]
private=root/'.env.quality-intelligence'
compose=['docker','compose','-f',str(root/'deploy/product-polish/compose.yml'),'exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','ajtool_carlos_local_admin']
def sql(db,text):
    r=subprocess.run(compose+['-d',db,'-At'],input=text,text=True,capture_output=True)
    if r.returncode: raise RuntimeError('Local analytics SQL failed; details withheld to protect generated credentials')
    return r.stdout
allowed={
 'cpk':json.loads((root/'artifacts/product-polish-20261027/staging/cpk-synthetic-study.json').read_text())['id'],
 'msa':json.loads((root/'artifacts/product-polish-20261027/staging/msa-synthetic-study.json').read_text())['id']}
for tag in ['cpk','msa']:
    extra=json.loads((root/f'artifacts/product-polish-20261027/staging/{"cpk-skipped" if tag=="cpk" else "msa-pending"}.json').read_text())['studyId']
    count=sql('ajtool_'+tag,f"SELECT count(*) FROM public.studies WHERE id NOT IN ('{allowed[tag]}','{extra}');")
    if count.strip()!='0': raise RuntimeError('Unexpected staging records: refusing analytics provisioning')
if private.exists():
    if not (private/'reader.env').exists():raise RuntimeError('Incomplete local configuration; preserve and inspect it')
    print('Reusing existing local analytics credentials; no rotation.')
else:
    exists=sql('ajtool_cpk',"SELECT count(*) FROM pg_roles WHERE rolname='ajtool_local_analytics_reader';")
    if exists.strip()!='0':raise RuntimeError('Unknown existing analytics role; refusing to replace it')
    password=secrets.token_hex(32)
    sql('ajtool_cpk',f"CREATE ROLE ajtool_local_analytics_reader LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS; ALTER ROLE ajtool_local_analytics_reader SET default_transaction_read_only=on;")
    private.mkdir(mode=0o700)
    (private/'reader.env').write_text(''.join(f'{tag.upper()}_DATABASE_URL=postgresql://ajtool_local_analytics_reader:{password}@db:5432/ajtool_{tag}\n' for tag in ['cpk','msa']))
    (private/'reader.env').chmod(0o600)
views=(root/'analytics/sql/views.sql').read_text()
for tag in ['cpk','msa']:
    sql('ajtool_'+tag,views+f"\nGRANT CONNECT ON DATABASE ajtool_{tag} TO ajtool_local_analytics_reader; GRANT USAGE ON SCHEMA ajtool_analytics TO ajtool_local_analytics_reader; GRANT SELECT ON ALL TABLES IN SCHEMA ajtool_analytics TO ajtool_local_analytics_reader;")
print('Prepared minimized views and a real non-owner SELECT-only role in the existing local staging databases. No new database or operational rows created.')
