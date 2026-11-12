"""AJTool continuity: local state, append-only events, safe versioned Obsidian export.

No network, no credentials, no reading application .env files. External writes
only happen with explicit sync-obsidian --apply and filesystem authorization.
"""
from pathlib import Path
from datetime import datetime, timezone
import argparse, hashlib, json, re

ROOT = Path(__file__).resolve().parents[1]
MEMORY = ROOT / 'docs/continuity'
FILES = ['START-HERE.md', 'HANDOFF.md', 'DECISIONS.md', 'SOURCES.md', 'HISTORY.md', 'PROTOCOL.md']
MARKER = '<!-- AJTOOL_CONTINUITY_GENERATED_V1 -->'

def state():
    return json.loads((MEMORY/'state.json').read_text(encoding='utf-8'))

def digest(data):
    return hashlib.sha256(data).hexdigest()

def brief():
    s=state()
    latest=s.get('officialRelease',{})
    delivery=(f"{latest['status']}; {latest['uniqueTests']} pruebas distintas" if latest else f"{s['localDelivery']['status']}; {s['localDelivery']['tests']['total']} pruebas históricas")
    return '\n'.join([
        '# AJTool — continuar desde aquí',
        f"Objetivo: {s['activeObjective']}",
        f"Railway de Carlos: {s['railway']['officialProjectName']} (distinto del personal).",
        f"Supabase existente: {s['supabase']['projectName']} / {s['supabase']['projectRef']}.",
        f"Supabase: {s['supabase']['dashboardUrl']}",
        f"Entrega local: {delivery}.",
        f"Remoto actual: {s['officialTools']['currentRemoteStatus']}",
        f"Obsidian: {s['obsidian']['vault']}; sincronización: {s['obsidian']['syncStatus']}",
        f"Siguiente: {s['nextAction']}",
        'Leer HANDOFF.md y SOURCES.md. No recrear recursos ni pedir secretos.'
    ])

def check():
    s=state()
    for name in FILES:
        if not (MEMORY/name).is_file():raise ValueError('Missing continuity document: '+name)
    review=json.loads((ROOT/s['localDelivery']['reviewEvidence']).read_text())
    if review['total']!=s['localDelivery']['tests']['total'] or review['failures']!=0:
        raise ValueError('Continuity test claims differ from evidence')
    manifest=json.loads((ROOT/s['localDelivery']['manifest']).read_text())
    if digest((ROOT/s['localDelivery']['package']).read_bytes())!=manifest['packageSha256']:
        raise ValueError('Delivery package hash mismatch')
    if s['railway']['officialProjectName']==s['railway']['personalProjectName']:
        raise ValueError('Official/personal destination collision')
    if not (MEMORY/'events.jsonl').exists():raise ValueError('Missing action ledger')
    ids=set()
    for line in (MEMORY/'events.jsonl').read_text().splitlines():
        event=json.loads(line)
        if event['id'] in ids:raise ValueError('Duplicate event id')
        ids.add(event['id'])
    result={'status':'PASS','historicalLocalTests':review['total'],'historicalPackageHashVerified':True,'events':len(ids),'remoteStatus':'NOT VERIFIED DURABLE'}
    latest=s.get('officialRelease')
    if latest:
        summary=json.loads((ROOT/latest['testSummary']).read_text())
        if summary['status'] not in ('PASS','PASS_ACROSS_DOCUMENTED_RUNS') or summary.get('failed',summary.get('failedInAcceptedCoverage'))!=0 or summary.get('totalUniqueTests',summary.get('uniqueTests'))!=latest['uniqueTests']:
            raise ValueError('Current release test summary mismatch')
        result['currentLocalUniqueTests']=summary.get('totalUniqueTests',summary.get('uniqueTests'))
        if latest.get('package'):
            metadata=json.loads((ROOT/latest['metadata']).read_text())
            if digest((ROOT/latest['package']).read_bytes())!=metadata['packageSha256']:
                raise ValueError('Current release package hash mismatch')
            result['currentPackageHashVerified']=True
    return result

def safe_text(text):
    if re.search(r'(?i)(postgres(?:ql)?://|bearer\s+\S+|(?:password|token|api[_-]?key|secret)\s*[=:]\s*\S+|sb_secret_|\bsk-[a-z0-9]{12})',text):
        raise ValueError('Possible secret: do not store credentials in continuity')

def record(agent,status,action,evidence):
    for value in [agent,action,*evidence]:safe_text(value)
    if not evidence:raise ValueError('An evidence reference is required')
    for value in evidence:
        if value.startswith('chat:'):continue
        path=(ROOT/value).resolve()
        if not path.is_relative_to(ROOT) or not path.is_file():raise ValueError('Evidence must be an existing repo file or chat reference')
        if any(p.startswith('.env') and p!='.env.example' for p in path.parts):raise ValueError('Do not link private credential files in memory')
    now=datetime.now(timezone.utc).isoformat(timespec='microseconds')
    event={'id':now+'-'+digest((agent+action).encode())[:8],'atUtc':now,'agent':agent,'status':status,'action':action,'evidence':evidence}
    with (MEMORY/'events.jsonl').open('a',encoding='utf-8') as out:out.write(json.dumps(event,ensure_ascii=False)+'\n')
    return event

def bundle():
    check();s=state()
    files={name:(MEMORY/name).read_bytes() for name in FILES}
    # Keep sync receipts out of bundle content to avoid recursive hash changes.
    public=json.loads(json.dumps(s));public['obsidian'].pop('syncStatus',None)
    files['CURRENT.md']=('# Estado recuperado de AJTool\n\n```json\n'+json.dumps(public,ensure_ascii=False,indent=2)+'\n```\n').encode()
    files['ACTIONS.md']=('# Acciones registradas\n\n'+''.join(
        '- **'+e['atUtc']+' · '+e['agent']+' · '+e['status']+'** — '+e['action']+'\n  Evidencia: '+', '.join(e['evidence'])+'\n'
        for e in map(json.loads,(MEMORY/'events.jsonl').read_text().splitlines()))).encode()
    combined=''.join(name+digest(content) for name,content in sorted(files.items()))
    version=s['updatedAt'][:10]+'-'+digest(combined.encode())[:12]
    manifest={name:digest(content) for name,content in files.items()}
    files['MANIFEST.json']=(json.dumps(manifest,indent=2)+'\n').encode()
    return version,files

def immutable_write(path,data):
    if path.exists():
        if path.is_symlink() or path.read_bytes()!=data:raise ValueError('Refusing to overwrite a changed snapshot: '+path.name)
        return
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('xb')as out:out.write(data)

def prepare():
    version,files=bundle()
    base=ROOT/'artifacts/continuity-20261027/obsidian/06_Agents_Reports/ajtool_continuity'
    for name,data in files.items():immutable_write(base/version/name,data)
    index=(MARKER+'\n# AJTool — memoria compartida\n\n'+f'[[06_Agents_Reports/ajtool_continuity/{version}/START-HERE|Empezar aquí]]\n\n'+f'[[06_Agents_Reports/ajtool_continuity/{version}/CURRENT|Estado]] · [[06_Agents_Reports/ajtool_continuity/{version}/HANDOFF|Traspaso]] · [[06_Agents_Reports/ajtool_continuity/{version}/ACTIONS|Acciones]]\n\nSnapshot versionado; fuentes técnicas en el repositorio. No contiene secretos.\n').encode()
    (base/'AJTool - Continuidad.md').write_bytes(index)
    return version,files,base,index

def sync(vault,apply=False):
    version,files,stage,index=prepare()
    vault=Path(vault).resolve()
    if not (vault/'.obsidian').is_dir():raise ValueError('The selected directory is not an existing Obsidian vault')
    target=vault/'06_Agents_Reports/ajtool_continuity'
    if target.resolve()!=target:raise ValueError('Symlinked output path refused')
    receipt_file=MEMORY/'sync-receipt.json'
    current=target/'AJTool - Continuidad.md'
    if current.exists() and current.read_bytes()!=index:
        receipt=json.loads(receipt_file.read_text()) if receipt_file.exists() else {}
        if receipt.get('vault')!=str(vault) or receipt.get('indexSha256')!=digest(current.read_bytes()):
            raise ValueError('Existing index changed or belongs to another writer; preserve it and review')
    result={'version':version,'target':str(target),'files':len(files)+1,'applied':False,'localExport':str(stage)}
    if not apply:return result
    # Preflight every target before writing; unknown notes are never enumerated/deleted.
    for name,data in files.items():
        path=target/version/name
        if path.exists() and (path.is_symlink() or path.read_bytes()!=data):raise ValueError('Snapshot conflict; no overwrite allowed')
    for name,data in files.items():immutable_write(target/version/name,data)
    if current.exists() and current.read_bytes()!=index:
        immutable_write(target/'history'/('index-'+digest(current.read_bytes())[:12]+'.md'),current.read_bytes())
    if current.is_symlink():raise ValueError('Symlinked index refused')
    temporary=target/'AJTool - Continuidad.md.pending'
    if temporary.exists():raise ValueError('Unfinished write found; review before retrying')
    temporary.write_bytes(index);temporary.replace(current)
    result.update(applied=True,vault=str(vault),indexSha256=digest(index),syncedAtUtc=datetime.now(timezone.utc).isoformat())
    receipt_file.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    s=state();s['obsidian']['syncStatus']='SYNCED: see docs/continuity/sync-receipt.json'
    (MEMORY/'state.json').write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return result

def verify():
    receipt=json.loads((MEMORY/'sync-receipt.json').read_text())
    target=Path(receipt['target']);version=receipt['version']
    manifest=json.loads((target/version/'MANIFEST.json').read_text())
    for name,expected in manifest.items():
        if Path(name).name!=name:raise ValueError('Invalid snapshot filename')
        if digest((target/version/name).read_bytes())!=expected:raise ValueError('Vault file changed: '+name)
    if digest((target/'AJTool - Continuidad.md').read_bytes())!=receipt['indexSha256']:
        raise ValueError('Vault index changed')
    return {'status':'PASS','vault':receipt['vault'],'snapshot':version,'verifiedFiles':len(manifest)+2}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    commands=parser.add_subparsers(dest='command',required=True)
    for name in ['brief','check','prepare-obsidian','verify-obsidian']:commands.add_parser(name)
    add=commands.add_parser('record');add.add_argument('--agent',required=True)
    add.add_argument('--status',choices=['VERIFIED_LOCAL','REPORTED_HISTORICAL','BLOCKED','FAILED','DECIDED'],required=True)
    add.add_argument('--action',required=True);add.add_argument('--evidence',action='append',required=True)
    push=commands.add_parser('sync-obsidian');push.add_argument('--vault',default=state()['obsidian']['vault']);push.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    if args.command=='brief':print(brief());return
    if args.command=='check':result=check()
    elif args.command=='verify-obsidian':result=verify()
    elif args.command=='prepare-obsidian':version,files,path,_=prepare();result={'version':version,'files':len(files)+1,'localExport':str(path),'vaultWritten':False}
    elif args.command=='record':result=record(args.agent,args.status,args.action,args.evidence)
    else:result=sync(args.vault,args.apply)
    print(json.dumps(result,ensure_ascii=False,indent=2))

if __name__=='__main__':
    try:main()
    except (ValueError,OSError,KeyError) as error:
        raise SystemExit('Continuity operation stopped: '+str(error))
