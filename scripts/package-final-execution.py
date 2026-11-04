"""Freeze final source commit plus safe evidence; deterministic ZIP, no private data."""
from pathlib import Path
from urllib.parse import urlsplit,unquote
import zipfile,hashlib,json,subprocess,io
root=Path(__file__).resolve().parents[1]
sha=lambda x:hashlib.sha256(x).hexdigest()
def git(*args):return subprocess.check_output(['git',*args],cwd=root).decode().strip()
out=root/'artifacts/final-execution-20261101';out.mkdir(exist_ok=True)
revision=git('rev-parse','HEAD')
assert not git('diff','--name-only','HEAD','--','.dockerignore','.gitattributes','docker','db','scripts','deploy/official'),'Commit final source changes first'
base=root/'artifacts/final-production-closure-20261029/AJTool-Database-RC-20261030.zip'
assert sha(base.read_bytes())=='4db05568f18525a31a439e14b36541f4da35b6a99be66bccfeb3a6060c421b2b'
with zipfile.ZipFile(base) as z:files={n:z.read(n) for n in z.namelist() if n not in ['MANIFEST.json','RELEASE-METADATA.json','README-RC.txt']}
paths=git('ls-files','-z','--','.dockerignore','.gitattributes','docker','db','scripts','deploy/official','docs/FINAL-EXECUTION-RUNBOOK-20261101.md','docs/POSTGRES-RELEASE-CHECKPOINT-20261101.md').split('\0')
overlays=[]
for name in paths:
 if not name:continue
 p=root/name
 if p.is_file():files[name]=p.read_bytes();overlays.append(name)
connections=json.loads((out/'connections.json').read_text())
services=json.loads((out/'owned-services.json').read_text())
assert connections['status']=='BOTH_PRIVATE_CONNECTIONS_CERTIFIED'
assert services['status']=='OWN_LOOPBACK_SERVICES_REAL_SUPABASE_PASS' and services['revision']==revision
for name in ['connections.json','owned-services.json','official-status.json','dashboard-current.json','monitor/current.json']:
 p=out/name
 assert p.is_file()
 files['artifacts/final-execution-20261101/'+name]=p.read_bytes()
for name in ['backup-receipt.json','restore-receipt.json','remote-migration-receipt.json','staging-acceptance.json','dashboard-acceptance.json','rls-negative-probes.json','test-summary-20261101.json']:
 p=root/'artifacts/real-postgres-20261101'/name
 files['artifacts/real-postgres-20261101/'+name]=p.read_bytes()
metadata={'candidate':'AJTool final execution20261101','sourceCommit':revision,'branch':git('branch','--show-current'),'sourceOverlayFiles':sorted(overlays),'baseArchiveSha256':sha(base.read_bytes()),'bothPrivateCredentialsCertified':True,'ownPublicationScope':'workstation loopback, real Supabase','officialOrcaDeployed':False,'officialRamDispositionComplete':False,'officialGo':False}
files['RELEASE-METADATA.json']=(json.dumps(metadata,indent=2)+'\n').encode()
files['README-RC.txt']=b'Committed source candidate. Both SQL credentials certified; own localhost services use real Supabase. Read docs/FINAL-EXECUTION-RUNBOOK-20261101.md. Official ORCA rollout/RAM decisions still pending: NO official GO. No private credential, backup, raw historical data or dashboard capability is included.\n'
secrets=[]
for p in (root/'.env.ajtool-supabase').glob('*.env'):
 for line in p.read_text(encoding='utf-8-sig').splitlines():
  if '=' not in line or line.lstrip().startswith('#'):continue
  k,v=line.split('=',1);v=v.strip().strip('"').strip("'")
  if v and any(s in k for s in ['PASSWORD','DATABASE_URL','TOKEN','SECRET']):
   secrets.append(v.encode())
   if 'DATABASE_URL' in k and urlsplit(v).password:secrets.append(unquote(urlsplit(v).password).encode())
for name,data in files.items():
 assert not any(p.startswith('.env') and p!='.env.example' for p in Path(name).parts)
 assert not name.endswith(('.dpapi','.dump'))
 assert not any(len(value)>=12 and value in data for value in secrets),'Secret value detected; package refused'
manifest={n:sha(d) for n,d in sorted(files.items())};files['MANIFEST.json']=(json.dumps(manifest,indent=2)+'\n').encode()
def build():
 b=io.BytesIO()
 with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
  for name,data in sorted(files.items()):
   entry=zipfile.ZipInfo(name,(2026,11,1,0,0,0));entry.compress_type=zipfile.ZIP_DEFLATED;entry.external_attr=0o100644<<16;z.writestr(entry,data)
 return b.getvalue()
data=build();assert data==build()
target=out/('AJTool-Final-Release-'+revision[:12]+'.zip')
if target.exists():assert target.read_bytes()==data,'Refuse overwrite of different release'
else:target.write_bytes(data)
with zipfile.ZipFile(target) as z:
 for name,digest in manifest.items():assert sha(z.read(name))==digest
report={'status':'FINAL_COMMITTED_CANDIDATE_VERIFIED','sourceCommit':revision,'package':target.name,'sha256':sha(data),'manifestEntries':len(manifest),'byteIdenticalRepeatBuild':True,'manifestVerified':True,'privateSecretScanPassed':True,'officialGo':False}
(out/'candidate.json').write_bytes((json.dumps(report,indent=2)+'\n').encode());print(json.dumps(report))
