// Test-only certificate generator discovery. Never changes application TLS validation.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
export function resolveOpenSsl(){
  const override=process.env.AJTOOL_OPENSSL_BIN;
  const candidates=override?[override]:['openssl',...(process.platform==='win32'?[join(process.env.ProgramFiles||'C:\\Program Files','Git','usr','bin','openssl.exe')]:[])];
  for(const executable of candidates){
    if(executable!=='openssl'&&!existsSync(executable))continue;
    const result=spawnSync(executable,['version'],{encoding:'utf8',windowsHide:true,timeout:10000});
    if(result.status===0&&/^OpenSSL\s/.test(result.stdout))return executable;
  }
  throw new Error('OPENSSL_TEST_PREREQUISITE_MISSING: install OpenSSL or set AJTOOL_OPENSSL_BIN to its executable (Git for Windows includes usr/bin/openssl.exe). Certificate validation remains required.');
}
