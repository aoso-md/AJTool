"""DPAPI CurrentUser custody for local PostgreSQL backup; never prints plaintext."""
import importlib.util
from pathlib import Path
import sys
spec = importlib.util.spec_from_file_location('ajtool_capture', Path(__file__).with_name('capture-ram-readonly.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
data = sys.stdin.buffer.read()
try:
    sys.stdout.buffer.write(module.crypt(data, decrypt=sys.argv[1] == 'decrypt'))
except Exception:
    sys.stderr.write('PRIVATE_BACKUP_CRYPTO_FAILED\n')
    sys.exit(2)
