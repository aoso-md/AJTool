"""Bundle the reviewed local candidate and synthetic evidence; never overwrite a release."""
from pathlib import Path
import subprocess, hashlib, json, zipfile

root=Path(__file__).resolve().parents[2]
out=root/'artifacts/product-polish-20261027'
target=out/'AJTool-product-polish-20261027.zip'
names=subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],cwd=root).decode().split('\0')
files=set()
fixed={'.dockerignore','.gitignore','.gitattributes','railway.toml','DESIGN.md','UX-CONTRACT.md','premium-ui.json','docs/CONTRATO.md','docs/METHODOLOGY-AUTHORITY-20261023.md','docs/PRODUCT-POLISH-20261027.md','docs/REVISION-RAILWAY-20261027.md'}
excluded={'db/review/browser-review.mjs','db/review/preview-server.mjs','db/review/public-sso-probe.mjs'}
for name in names:
    path=root/name
    if not name or not path.is_file() or name in excluded: continue
    if name in fixed or name.startswith(('tools/','docker/','db/','.github/','deploy/product-polish/','deploy/carlos/')):
        files.add(path)
for service in ['calculate-cpk-ppk','run-msa-analysis']:
    files.update(p for p in (root/'tools'/service/'web/dist').rglob('*') if p.is_file())
# Only this phase's synthetic evidence; no baseline copies, other projects or credentials.
for p in out.rglob('*'):
    if p.is_file() and 'baseline-source' not in p.parts and p.suffix in {'.json','.jsonl','.txt','.png','.patch'} and p.name not in {'delivery-manifest.json','SHA256.txt'}:
        files.add(p)
private=[]
for tag in ['cpk','msa']:
    env=(root/f'.env.product-polish/{tag}.env').read_text()
    url=next(line.split('=',1)[1] for line in env.splitlines() if line.startswith('DATABASE_URL='))
    from urllib.parse import urlparse
    private.extend([url,urlparse(url).password])
manifest=[]
with zipfile.ZipFile(target,'x',zipfile.ZIP_DEFLATED) as archive:
    intro=b'AJTool local product polish. Read docs/PRODUCT-POLISH-20261027.md. Synthetic local staging only. No production deployment authorized. See MANIFEST.json for exact included files.\n'
    archive.writestr('README-POLISH.txt',intro)
    manifest.append({'path':'README-POLISH.txt','sha256':hashlib.sha256(intro).hexdigest()})
    for p in sorted(files):
        name=p.relative_to(root).as_posix()
        assert not any(x=='node_modules' or (x.startswith('.env') and x!='.env.example') for x in Path(name).parts),name
        data=p.read_bytes()
        assert not any(value.encode() in data for value in private),f'Private staging value detected in {name}'
        archive.writestr(name,data)
        manifest.append({'path':name,'sha256':hashlib.sha256(data).hexdigest()})
    archive.writestr('MANIFEST.json',json.dumps(manifest,indent=2)+'\n')
result={'branch':subprocess.check_output(['git','branch','--show-current'],cwd=root,text=True).strip(),'baseHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'includesUncommittedCandidate':True,'productionChanged':False,'packageSha256':hashlib.sha256(target.read_bytes()).hexdigest(),'files':manifest}
(out/'delivery-manifest.json').write_text(json.dumps(result,indent=2)+'\n',encoding='utf-8')
(out/'SHA256.txt').write_text(result['packageSha256']+'  '+target.name+'\n',encoding='utf-8')
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    for entry in manifest: assert hashlib.sha256(archive.read(entry['path'])).hexdigest()==entry['sha256']
print(json.dumps({'files':len(manifest),'packageSha256':result['packageSha256'],'verified':True}))
