import {randomBytes,pbkdf2Sync,createHmac,createHash} from 'node:crypto';
export function scramVerifier(password){
 // Printable ASCII avoids SASLprep ambiguities; use a password-manager value.
 if(typeof password!=='string'||password.length<24||password.length>256||!/^[\x21-\x7e]+$/.test(password))throw Object.assign(new Error(),{code:'RUNTIME_PASSWORD_REQUIRES_24_PRINTABLE_ASCII_CHARACTERS'});
 const salt=randomBytes(16),salted=pbkdf2Sync(password,salt,4096,32,'sha256');
 const clientKey=createHmac('sha256',salted).update('Client Key').digest();
 const stored=createHash('sha256').update(clientKey).digest('base64');
 const server=createHmac('sha256',salted).update('Server Key').digest('base64');
 salted.fill(0);clientKey.fill(0);
 return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
