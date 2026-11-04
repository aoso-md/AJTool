import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as oidc from 'openid-client';
import { resolveAuthConfig } from '../src/platform/auth/oidc-config.js';
import { createAuthGateway } from '../src/platform/auth/auth-gateway.js';
const env = { OIDC_ISSUER: 'https://idp.example.test', OIDC_CLIENT_ID: 'synthetic-client', OIDC_CLIENT_SECRET: 'synthetic-secret', OIDC_REDIRECT_URI: 'https://tool.example.test/auth/callback', SESSION_SECRET: 'synthetic-session-secret-at-least-32-characters' };
function response() { return { headers: {}, setHeader(k,v) { this.headers[k]=v; }, set(k,v) { this.headers[k]=v; }, redirect(status,url) { this.statusCode=status; this.location=url; }, status(n) { this.statusCode=n; return this; }, json(body) { this.body=body; return this; } }; }
test('Carlos scope defaults to openid; explicit scope configuration must retain openid', () => {
  for (const value of [undefined, '', '  ', 'openid']) assert.equal(resolveAuthConfig({...env, OIDC_SCOPES:value}).scopes, 'openid');
  assert.equal(resolveAuthConfig({...env, OIDC_SCOPES:'openid profile openid'}).scopes, 'openid profile');
  assert.throws(() => resolveAuthConfig({...env, OIDC_SCOPES:'profile roles'}), /debe incluir openid/);
  assert.equal(resolveAuthConfig({}), null);
});
test('authorization redirect uses only openid with PKCE, state, nonce and secure handshake cookie', async () => {
  const config=resolveAuthConfig(env);
  const gateway=createAuthGateway(config, {discoverProvider:async () => new oidc.Configuration({issuer:env.OIDC_ISSUER,authorization_endpoint:env.OIDC_ISSUER+'/authorize',token_endpoint:env.OIDC_ISSUER+'/token'},env.OIDC_CLIENT_ID,env.OIDC_CLIENT_SECRET)});
  const res=response();
  await gateway.handleRoute({headers:{},query:{return_to:'/studies/1'}},res,'login');
  assert.equal(res.statusCode,302);
  const url=new URL(res.location);
  assert.equal(url.searchParams.get('scope'),'openid');
  assert.equal(url.searchParams.get('code_challenge_method'),'S256');
  for(const key of ['state','nonce','code_challenge']) assert.ok(url.searchParams.get(key)?.length >= 32);
  const cookie=res.headers['set-cookie'].find(value => value.startsWith('oidc_handshake=') && !value.includes('Max-Age=0'));
  for(const flag of ['HttpOnly','Secure','SameSite=Lax','Path=/']) assert.ok(cookie.includes(flag));
  assert.ok(!res.location.includes(env.OIDC_CLIENT_SECRET));
});
test('provider failure is redacted and discovery retries on next login', async () => {
  let calls=0; const logs=[];
  const gateway=createAuthGateway(resolveAuthConfig(env),{discoverProvider:async () => { calls++; throw new Error('private-provider-detail '+env.OIDC_CLIENT_SECRET); },log:{error:v=>logs.push(v)}});
  for(let i=0;i<2;i++) { const res=response(); await gateway.handleRoute({headers:{},query:{}},res,'login'); assert.equal(res.statusCode,502); assert.equal(res.body.error,'AUTH_UNAVAILABLE'); assert.ok(!JSON.stringify(res.body).includes(env.OIDC_CLIENT_SECRET)); }
  assert.equal(calls,2);
  assert.ok(!logs.join('').includes(env.OIDC_CLIENT_SECRET));
});
