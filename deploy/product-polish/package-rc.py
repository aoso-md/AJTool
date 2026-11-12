"""Package the committed RC plus exact served bundles and selected synthetic evidence."""
from pathlib import Path
import subprocess, json, hashlib, zipfile, datetime, io
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'artifacts/final-rc-20261028'
TARGET=OUT/'AJTool-RC-20261029.zip'
def git(*args):return subprocess.check_output(['git',*args],cwd=ROOT).decode().strip()
def sha(data):return hashlib.sha256(data).hexdigest()
assert git('branch','--show-current')=='release/final-rc-20261028'
assert not git('diff','--name-only','HEAD','--','tools','db','analytics','.github','docker','deploy/product-polish','docs/release-candidate-20261028'), 'Commit reviewed RC sources first'
assert not TARGET.exists(),'Never overwrite a release artifact'
prefixes=('tools/','db/','analytics/','docker/','.github/','deploy/product-polish/','deploy/carlos/','docs/release-candidate-20261028/')
fixed={'.dockerignore','.gitignore','.gitattributes','railway.toml','DESIGN.md','UX-CONTRACT.md','premium-ui.json','docs/CONTRATO.md','docs/METHODOLOGY-AUTHORITY-20261023.md','docs/ANALYTICS-ARCHITECTURE-20261028.md','docs/ANALYTICS-DATA-DICTIONARY-20261028.md','docs/ANALYTICS-VALIDATION-20261028.md'}
excluded={'db/review/browser-review.mjs','db/review/preview-server.mjs','db/review/public-sso-probe.mjs'}
files={}
for name in git('ls-files','-z').split('\0'):
    p=ROOT/name
    if name and p.is_file() and name not in excluded and (name in fixed or name.startswith(prefixes)):
        assert 'node_modules' not in p.parts and '__pycache__' not in p.parts
        files[name]=p
for tag,target in [('cpk','tools/calculate-cpk-ppk/web/dist'),('msa','tools/run-msa-analysis/web/dist'),('analytics','analytics/web/dist')]:
    base=OUT/'served'/tag
    assert (base/'index.html').is_file()
    for p in base.rglob('*'):
        if p.is_file():files[target+'/'+p.relative_to(base).as_posix()]=p
for p in OUT.rglob('*'):
    if p.is_file() and p.suffix in {'.json','.txt','.png','.md'} and 'served' not in p.relative_to(OUT).parts and p.name not in {'RC-METADATA.json','MANIFEST.json','SHA256.txt','git-after.txt'}:
        files[p.relative_to(ROOT).as_posix()]=p
private=[]
for folder in ['.env.product-polish','.env.quality-intelligence']:
    for p in (ROOT/folder).glob('*.env'):
        for line in p.read_text().splitlines():
            if '=' not in line:continue
            key,value=line.split('=',1)
            if value and ('PASSWORD' in key or 'KEY' in key or 'TOKEN' in key or 'DATABASE_URL' in key):
                private.append(value.encode())
                if 'DATABASE_URL' in key and urlsplit(value).password:private.append(urlsplit(value).password.encode())
for name in files:
    assert not any(part.startswith('.env') and part!='.env.example' for part in Path(name).parts), 'Private path excluded'
    assert not any(value in files[name].read_bytes() for value in private),'Private value found; packaging stopped'
manifest=[{'path':name,'sha256':sha(p.read_bytes()),'bytes':p.stat().st_size} for name,p in sorted(files.items())]
metadata={'createdAtUtc':datetime.datetime.fromtimestamp(int(git('show','-s','--format=%ct','HEAD')),datetime.timezone.utc).isoformat(),'branch':git('branch','--show-current'),'sourceCommit':git('rev-parse','HEAD'),'baseCommit':'cf7ffbd01f14ee88b3d9863630208d8d5ac2d9d4','tests':{'cpk':85,'msa':110,'postgres':180,'releaseGates':15,'analytics':21,'total':411,'failed':0},'privateValueScan':'PASS: actual private local connection/password values absent','frontendBundles':'Exact files from verified local containers, not native Windows builds','productionDurable':False,'remoteWritesPerformed':False,'restorePerformed':False,'entries':len(manifest),'package':TARGET.name}
contents={name:p.read_bytes() for name,p in sorted(files.items())}
contents['README-RC.txt']=b'AJTool RC: read docs/release-candidate-20261028/01-ARQUITECTURA-AS-BUILT.md and 07-RUNBOOK-DESPLIEGUE-SEGURO.md. Local synthetic acceptance only; official persistence remains NO-GO. No deployment authorized.\n'
contents['MANIFEST.json']=json.dumps(manifest,indent=2).encode()
contents['RC-METADATA.json']=json.dumps(metadata,indent=2).encode()
def build(stream):
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
        for name,data in sorted(contents.items()):
            info=zipfile.ZipInfo(name,date_time=(2026,10,29,0,0,0))
            info.compress_type=zipfile.ZIP_DEFLATED;info.create_system=3;info.external_attr=0o100644<<16
            archive.writestr(info,data)
first=io.BytesIO();second=io.BytesIO();build(first);build(second)
assert first.getvalue()==second.getvalue(),'Archive must be reproducible for identical inputs'
with TARGET.open('xb') as stream:stream.write(first.getvalue())
with zipfile.ZipFile(TARGET) as archive:
    assert archive.testzip() is None
    for entry in manifest:assert sha(archive.read(entry['path']))==entry['sha256']
metadata['packageSha256']=sha(TARGET.read_bytes());metadata['archiveVerified']=True;metadata['repeatBuildByteIdentical']=True
(OUT/'RC-METADATA.json').write_text(json.dumps(metadata,indent=2)+'\n',encoding='utf-8')
(OUT/'MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
(OUT/'SHA256.txt').write_text(metadata['packageSha256']+'  '+TARGET.name+'\n',encoding='utf-8')
print(json.dumps(metadata,indent=2))
