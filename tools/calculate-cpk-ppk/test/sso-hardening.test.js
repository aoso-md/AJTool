import {test} from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import * as oidc from 'openid-client';
import {createAuthGateway,safeReturnTo} from '../src/platform/auth/auth-gateway.js';
import {resolveAuthConfig} from '../src/platform/auth/oidc-config.js';
import {verifyValue} from '../src/platform/auth/signed-value.js';
import {signSession,buildCookie} from '../src/platform/auth/session-cookie.js';
import {loadConfig} from '../src/platform/config.js';

const env={OIDC_ISSUER:'https://idp.example.test',OIDC_CLIENT_ID:'synthetic',OIDC_CLIENT_SECRET:'synthetic-only',OIDC_REDIRECT_URI:'https://tool.example.test/auth/callback',SESSION_SECRET:'synthetic-test-session-secret-32-characters'};
const config=resolveAuthConfig(env);
const provider=()=>new oidc.Configuration({issuer:env.OIDC_ISSUER,authorization_endpoint:env.OIDC_ISSUER+'/authorize',token_endpoint:env.OIDC_ISSUER+'/token'},config.clientId,config.clientSecret);
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},set(k,v){this.headers[k]=v;},redirect(code,url){this.statusCode=code;this.location=url;},status(code){this.statusCode=code;return this;},json(body){this.body=body;return this;}});

test('login rejects external, control-character and backslash return paths',async()=>{
  const gateway=createAuthGateway(config,{discoverProvider:async()=>provider()});
  for(const path of ['https://evil.example','http://evil.example','//evil.example','/\\evil.example','/\t/evil.example','/\n/evil.example','/x\r\nLocation:evil','/x\u0000','/x\u007f','/a\\b']) {
    assert.equal(safeReturnTo(path),'/');
    const res=response();await gateway.handleRoute({headers:{},query:{return_to:path}},res,'login');
    assert.equal(res.statusCode,302);
    const cookie=res.headers['set-cookie'].find(c=>c.startsWith('oidc_handshake=')&&!c.includes('Max-Age=0'));
    assert.equal(verifyValue(cookie.split(';')[0].slice('oidc_handshake='.length),config.sessionSecret).returnTo,'/');
  }
  assert.equal(safeReturnTo('/studies/123?tab=results'),'/studies/123?tab=results');
});

test('DNS and timeout failures recover in the same gateway and successful discovery stays cached',async()=>{
  for(const code of ['ENOTFOUND','ETIMEDOUT']) {
    let calls=0;
    const gateway=createAuthGateway(config,{log:{error(){}},discoverProvider:async()=>{if(++calls===1)throw Object.assign(new Error('synthetic'),{code});return provider();}});
    const failed=response();await gateway.handleRoute({headers:{},query:{}},failed,'login');
    assert.equal(failed.statusCode,502);assert.equal(failed.body.error,'AUTH_UNAVAILABLE');
    for(let i=0;i<2;i++){const success=response();await gateway.handleRoute({headers:{},query:{}},success,'login');assert.equal(success.statusCode,302);assert.equal(new URL(success.location).searchParams.get('scope'),'openid');}
    assert.equal(calls,2);
  }
});

test('host-only root cookies stay Secure behind TLS termination and logout clears both handshake paths',async()=>{
  const gateway=createAuthGateway(config,{discoverProvider:async()=>provider()});
  const res=response();await gateway.handleRoute({headers:{'x-forwarded-proto':'https'},query:{},secure:false},res,'login');
  const cookie=res.headers['set-cookie'].find(c=>!c.includes('Max-Age=0'));
  for(const attr of ['Path=/;','HttpOnly','Secure','SameSite=Lax'])assert.ok(cookie.includes(attr));
  assert.ok(!cookie.includes('Domain='));
  assert.ok(res.headers['set-cookie'].some(c=>c.includes('Path=/auth;')&&c.includes('Max-Age=0')));
  const session=buildCookie({name:'ccp_session',value:'synthetic',maxAgeSeconds:60,secure:true});
  for(const attr of ['Path=/;','HttpOnly','Secure','SameSite=Lax'])assert.ok(session.includes(attr));
  assert.ok(!session.includes('Domain='));
  const out=response();await gateway.handleRoute({headers:{}},out,'logout');
  assert.ok(out.headers['set-cookie'].every(c=>c.includes('Max-Age=0')));
  assert.ok(out.headers['set-cookie'].some(c=>c.includes('Path=/auth;')));
  assert.ok(out.headers['set-cookie'].some(c=>c.startsWith('oidc_handshake=')&&c.includes('Path=/;')));
});

test('production and staging require persistence; publication remains shadow by default',()=>{
  for(const settings of [{NODE_ENV:'production'},{NODE_ENV:'staging'},{AJTOOL_ENVIRONMENT:'staging'},{DATABASE_REQUIRED:'true'}]) {
    const cfg=loadConfig(settings,{localPort:8108});assert.equal(cfg.databaseRequired,true);assert.equal(cfg.publishMode,'shadow');
  }
});

test('signed roleless user remains authenticated but protected action is 403; anonymous is 401',async()=>{
  Object.assign(process.env,env);delete process.env.TOOL_API_KEY;
  const {attachCaller,requireRole,describeSession}=await import('../src/platform/auth/index.js');
  const app=express();app.use(attachCaller);
  app.get('/auth/me',(req,res)=>res.json(describeSession(req)));
  app.get('/protected',requireRole('QualityEngineer'),(req,res)=>res.json({ok:true}));
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  const headers={cookie:`tool_session=${signSession({sub:'test',roles:[],exp:Math.floor(Date.now()/1000)+60},env.SESSION_SECRET)}`};
  try {
    const me=await fetch(url+'/auth/me',{headers});const body=await me.json();assert.equal(body.authenticated,true);assert.deepEqual(body.user.roles,[]);
    const denied=await fetch(url+'/protected',{headers});assert.equal(denied.status,403);assert.equal((await denied.json()).error,'insufficient_role');
    assert.equal((await fetch(url+'/protected')).status,401);
  } finally {await new Promise(r=>server.close(r));}
});
