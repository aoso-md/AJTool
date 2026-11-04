// Offline sealing only. Keys remain in the operator secret store, never in logs.
import {randomBytes,createCipheriv,createDecipheriv,createHash} from 'node:crypto';
const digest=data=>createHash('sha256').update(data).digest('hex');
function checkKey(key){if(!Buffer.isBuffer(key)||key.length!==32)throw new Error('backup_key_must_be_32_bytes');}
export function sealArchive(data,key,metadata={}){
 checkKey(key);const iv=randomBytes(12);
 const header={format:'ajtool-postgres-backup-v1',algorithm:'AES-256-GCM',sha256:digest(data),metadata};
 const cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(JSON.stringify(header)));
 const ciphertext=Buffer.concat([cipher.update(data),cipher.final()]);
 return Buffer.from(JSON.stringify({header,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')}));
}
export function openArchive(archive,key){
 checkKey(key);
 try{
  const {header,iv,tag,ciphertext}=JSON.parse(archive.toString('utf8'));
  if(header?.format!=='ajtool-postgres-backup-v1'||header?.algorithm!=='AES-256-GCM')throw new Error();
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));
  decipher.setAAD(Buffer.from(JSON.stringify(header)));decipher.setAuthTag(Buffer.from(tag,'base64'));
  const data=Buffer.concat([decipher.update(Buffer.from(ciphertext,'base64')),decipher.final()]);
  if(digest(data)!==header.sha256)throw new Error();
  return {data,metadata:header.metadata,sha256:header.sha256};
 }catch{throw new Error('backup_authentication_failed');}
}
