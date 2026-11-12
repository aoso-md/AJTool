"""Deterministic reviewed-source overlay; excludes all private data and credentials."""
from pathlib import Path
from urllib.parse import urlsplit,unquote
import hashlib,json,subprocess,zipfile,io
root=Path(__file__).resolve().parents[1]
base=root/'artifacts/final-production-closure-20261029/AJTool-Database-RC-20261030.zip'
out=root/'artifacts/real-postgres-20261101'
sha=lambda x:hashlib.sha256(x).hexdigest()
assert sha(base.read_bytes())=='4db05568f18525a31a439e14b36541f4da35b6a99be66bccfeb3a6060c421b2b'
scripts=['Test-AJToolPostgresPassword.ps1','test-supabase-password.mjs','sql-private-config.mjs','sql-private-config.test.mjs','runtime-secret.mjs','test-runtime-secret-local.mjs','inspect-authorized-supabase.mjs','backup-authorized-supabase.mjs','private-backup-crypto.py','capture-ram-readonly.py','restore-authorized-backup.mjs','migrate-restored-rls.mjs','accept-restored-staging.mjs','accept-restored-dashboard.mjs','probe-restored-rls.mjs','apply-authorized-private-rls.mjs','package-postgres-checkpoint.py']
names=['scripts/'+s for s in scripts]+['db/migrate.sql','db/rls-private-contract.sql','db/review/certs/supabase-prod-ca-2021.crt','docs/POSTGRES-RELEASE-CHECKPOINT-20261101.md','docs/SQL-AUTH-ROTATION-20261101.md','docs/AJTOOL-FINAL-PRODUCTION-CLOSURE.md']
evidence=['backup-receipt.json','restore-receipt.json','migration-rls-receipt.json','rls-negative-probes.json','staging-acceptance.json','dashboard-acceptance.json','remote-migration-receipt.json','official-ready-readonly.json','test-summary-20261101.json','runtime-secret-procedure-test.json']
names+=['artifacts/real-postgres-20261101/'+name for name in evidence]
with zipfile.ZipFile(base) as z:files={name:z.read(name) for name in z.namelist() if name not in ['MANIFEST.json','RELEASE-METADATA.json','README-RC.txt']}
for name in names:files[name]=(root/name).read_bytes()
metadata={'candidate':'AJTool PostgreSQL RLS checkpoint20261101','sourceBase':'3ac432873a9bf713ed46ee4acb47b4f235b8f0cc','checkoutHead':'09650bc895f466faa843e14f389a01f09b82d4dc','branch':'release/final-db-20261030','uncommittedOverlay':True,'baseZipSha256':sha(base.read_bytes()),'overlaidFiles':sorted(names),'postgresRemoteMigrated':True,'runtimeCredentialCertified':False,'railwayDeployed':False,'ramPreservationResolved':False,'officialGo':False}
files['RELEASE-METADATA.json']=(json.dumps(metadata,ensure_ascii=False,indent=2)+'\n').encode()
files['README-RC.txt']=b'LOCAL CANDIDATE ONLY. Read docs/POSTGRES-RELEASE-CHECKPOINT-20261101.md. Immutable base plus explicitly hashed uncommitted overlay. Supabase schema migrated; runtime private credential and Railway/RAM acceptance pending. No production GO. No private backup/data/secret is included.\n'
secrets=[]
private=root/'.env.ajtool-supabase'
for p in private.glob('*.env'):
 for line in p.read_text(encoding='utf-8-sig').splitlines():
  if '=' not in line or line.lstrip().startswith('#'):continue
  key,value=line.split('=',1);value=value.strip().strip('"').strip("'")
  if value and any(s in key for s in ['DATABASE_URL','PASSWORD','TOKEN','SECRET']):
   secrets.append(value.encode())
   if 'DATABASE_URL' in key and urlsplit(value).password:secrets.append(unquote(urlsplit(value).password).encode())
for name,data in files.items():
 assert not any(p.startswith('.env') and p!='.env.example' for p in Path(name).parts),'Private path excluded'
 assert not name.endswith(('.dump','.dpapi')),'Private backup excluded'
 assert not any(len(secret)>=12 and secret in data for secret in secrets),'Secret value detected; do not package'
manifest={name:sha(data) for name,data in sorted(files.items())}
files['MANIFEST.json']=(json.dumps(manifest,indent=2)+'\n').encode()
def build():
 stream=io.BytesIO()
 with zipfile.ZipFile(stream,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name,data in sorted(files.items()):
   entry=zipfile.ZipInfo(name,date_time=(2026,11,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o100644<<16;z.writestr(entry,data)
 return stream.getvalue()
data=build();assert data==build(),'Reproducible build failed'
target=out/'AJTool-PostgreSQL-RLS-RC-20261101.zip'
if target.exists():assert target.read_bytes()==data,'Refuse overwrite of different RC'
else:target.write_bytes(data)
with zipfile.ZipFile(target) as z:
 for name,digest in manifest.items():assert sha(z.read(name))==digest
receipt={'status':'REPRODUCIBLE_LOCAL_CANDIDATE','package':target.name,'sha256':sha(data),'manifestEntries':len(manifest),'byteIdenticalRepeatBuild':True,'manifestVerified':True,'privateSecretValueScanPassed':True,'privateBackupsIncluded':False,'uncommittedOverlay':True,'officialGo':False}
(out/'candidate-package.json').write_bytes((json.dumps(receipt,indent=2)+'\n').encode())
print(json.dumps(receipt))
