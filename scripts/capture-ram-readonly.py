"""Capture authorized AJTool GET interfaces privately. Never claims a complete RAM export."""
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TARGETS = {'calculate_cpk_ppk': 'https://ccp.orcalabs.mx', 'run_msa_analysis': 'https://rma.orcalabs.mx'}
LIMIT = 200
MAX_BYTES = 20 * 1024 * 1024


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class Blob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_ubyte))]


def crypt(data, decrypt=False):
    if os.name != 'nt':
        raise RuntimeError('Windows CurrentUser DPAPI is required')
    library = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    function = library.CryptUnprotectData if decrypt else library.CryptProtectData
    function.argtypes = [ctypes.POINTER(Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
                         ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(Blob)]
    function.restype = wintypes.BOOL
    kernel.LocalFree.argtypes = [ctypes.c_void_p]
    kernel.LocalFree.restype = ctypes.c_void_p
    source = ctypes.create_string_buffer(data)
    incoming = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = Blob()
    try:
        # CRYPTPROTECT_UI_FORBIDDEN. Default scope is the current Windows user.
        if not function(ctypes.byref(incoming), None, None, None, None, 1, ctypes.byref(outgoing)):
            raise RuntimeError('private_capture_crypto_failed')
        try:
            return ctypes.string_at(outgoing.pbData, outgoing.cbData)
        finally:
            kernel.LocalFree(outgoing.pbData)
    finally:
        ctypes.memset(source, 0, len(data))


def digest(value):
    return hashlib.sha256(value).hexdigest()


def fetch(base, route):
    if base not in TARGETS.values() or not route.startswith('/'):
        raise ValueError('unapproved_target')
    request = urllib.request.Request(base + route, headers={'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0 AJTool-ReadOnly-Preservation'})
    try:
        with urllib.request.build_opener(NoRedirects()).open(request, timeout=15) as response:
            raw = response.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                return {'ok': False, 'reason': 'response_size_limit'}
            if 'application/json' not in response.headers.get('Content-Type', ''):
                return {'ok': False, 'reason': 'not_json'}
            return {'ok': True, 'http': response.status, 'body': json.loads(raw)}
    except urllib.error.HTTPError as error:
        return {'ok': False, 'http': error.code, 'reason': 'http_read_failed'}
    except Exception:
        # Never log URLs containing IDs, response bodies or exception payloads.
        return {'ok': False, 'reason': 'read_failed'}


def capture():
    private = ROOT / '.env.ajtool-ram-preservation'
    subprocess.run(['git', 'check-ignore', '-q', str(private / 'capture.dpapi')], cwd=ROOT, check=True)
    private.mkdir(exist_ok=True)
    evidence = ROOT / 'artifacts/remote-release-unblock-20261030'
    evidence.mkdir(exist_ok=True)
    receipt = {'observedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'scope': 'bounded authorized GET capture only',
               'remoteWrites': False, 'ramInventoryComplete': False, 'allRecordsClassification': 'UNKNOWN',
               'custody': 'DPAPI CurrentUser; Windows profile/keys required; cross-machine recovery unverified', 'tools': {}}
    for tool, base in TARGETS.items():
        start = datetime.datetime.now(datetime.timezone.utc).isoformat()
        ready = fetch(base, '/ready')
        if not ready.get('ok') or not isinstance(ready.get('body'), dict) or ready['body'].get('tool') != tool:
            receipt['tools'][tool] = {'sourceIdentityVerified': False, 'visibleStudies': None, 'totalRamStudies': 'UNKNOWN'}
            continue
        listed = fetch(base, '/api/studies?limit=200')
        body = listed.get('body')
        rows = body.get('studies') if isinstance(body, dict) else None
        if not isinstance(rows, list):
            receipt['tools'][tool] = {'listReadable': False, 'visibleStudies': None, 'totalRamStudies': 'UNKNOWN'}
            continue
        ids = [row.get('id') for row in rows if isinstance(row, dict)]
        valid = [value for value in ids if isinstance(value, str) and 0 < len(value) <= 256]
        documents = {}
        for value in valid[:LIMIT]:
            documents[value] = fetch(base, '/api/studies/' + urllib.parse.quote(value, safe=''))
        routes = {route: fetch(base, route) for route in ['/api/settings', '/api/status']}
        routes['/ready'] = ready
        if tool == 'calculate_cpk_ppk':
            routes['/api/specs'] = fetch(base, '/api/specs')
        repeated = fetch(base, '/api/studies?limit=200')
        again = repeated.get('body', {}).get('studies', []) if isinstance(repeated.get('body'), dict) else []
        id_set_stable = sorted(valid) == sorted([x.get('id') for x in again if isinstance(x, dict) and isinstance(x.get('id'), str)])
        bundle = {'tool': tool, 'source': base, 'startedAtUtc': start, 'completedAtUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  'listed': listed, 'documents': documents, 'routes': routes, 'repeatedList': repeated,
                  'complete': False, 'consistentCutProven': False, 'allInstancesCovered': False}
        raw = json.dumps(bundle, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
        sealed = crypt(raw)
        assert crypt(sealed, decrypt=True) == raw, 'private_capture_roundtrip_failed'
        name = tool + '-' + secrets.token_hex(8) + '.dpapi'
        with (private / name).open('xb') as stream:
            stream.write(sealed)
        receipt['tools'][tool] = {'sourceIdentityVerified': True, 'listReadable': True, 'requestedLimit': LIMIT, 'visibleStudies': len(rows),
            'studyDocumentsReadable': sum(1 for x in documents.values() if x.get('ok')),
            'studyIdSetSha256': digest(json.dumps(sorted(valid), separators=(',', ':')).encode()),
            'idSetStableDuringCapture': id_set_stable, 'totalRamStudies': 'UNKNOWN',
            'encryptedFileName': name, 'encryptedSha256': digest(sealed), 'payloadSha256': digest(raw),
            'localDecryptEqualityVerified': True, 'supabaseComparison': 'UNKNOWN_NO_CURRENT_SOURCE_SNAPSHOT',
            'gaps': ['API list cap200; store may retain500', 'settings API history limited10',
                     'no complete internal queues/cursors export', 'deployed SHA and every replica unverified',
                     'multi-request capture is not a consistent snapshot']}
        print(tool + ': bounded capture encrypted and locally recovered; complete=false', flush=True)
    (evidence / 'ram-capture-receipt.json').write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    if sys.argv[1:] == ['--self-test']:
        test = b'AJTool synthetic DPAPI fixture only'
        sealed = crypt(test)
        assert crypt(sealed, decrypt=True) == test
        try:
            crypt(sealed[:-1] + bytes([sealed[-1] ^ 1]), decrypt=True)
        except RuntimeError:
            print('DPAPI synthetic roundtrip PASS; tamper rejection PASS')
        else:
            raise RuntimeError('tampered_capture_not_rejected')
    elif not sys.argv[1:]:
        capture()
    else:
        raise SystemExit('Unsupported arguments')
