import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url)),origin='https://workspace.example',code='synthetic-account-security-bootstrap-24';
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
type Browser={cookies:Record<string,string>};
beforeAll(()=>{bundle=buildSync({stdin:{contents:`import worker from './src/index';import{accountSecurity}from './src/account_security';import{ApiError,json}from './src/types';export default{async fetch(request,env){try{return await accountSecurity(request,env)||await worker.fetch(request,env);}catch(error){return json({detail:error instanceof ApiError?error.message:'Request failed'},error instanceof ApiError?error.status:503);}}};`,resolveDir:root,sourcefile:'account-runtime.ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
beforeEach(async()=>{mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],kvNamespaces:['FILES_KV'],queueProducers:{APPLICATION_QUEUE:'security-tests'},bindings:{ACCESS_CODE:code,PUBLIC_BASE_URL:`${origin}/api`,ALLOWED_ORIGINS:origin,BROWSER_ENABLED:'false'}}));db=await mf.getD1Database('DB');await applyTestMigrations(db);},30000);
afterEach(async()=>{await mf?.dispose();},30000);
async function call(browser:Browser,path:string,body?:unknown,method=body===undefined?'GET':'POST',customOrigin=origin){
 const response=await mf.dispatchFetch(`https://api.example${path}`,{method,headers:{Origin:customOrigin,'Content-Type':'application/json','X-HireFlow-Access-Code':code,Cookie:Object.entries(browser.cookies).map(([k,v])=>`${k}=${v}`).join(';')},...(body===undefined?{}:{body:JSON.stringify(body)})});
 for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');browser.cookies[pair.slice(0,at)]=pair.slice(at+1);}
 return response;
}
async function owner(email='owner@example.com'){const browser:Browser={cookies:{}};const response=await call(browser,'/profile',{name:'Synthetic Owner',email,mode:'internship',skills:['Python']});expect(response.status,await response.clone().text()).toBe(201);return{browser,user:await response.json()as any};}
const b64=(value:Uint8Array|string)=>Buffer.from(value).toString('base64url');
const sha=(value:Uint8Array|string)=>createHash('sha256').update(value).digest();
function authenticator(){
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),id=randomBytes(32);
 const cose=isoCBOR.encode(new Map<any,any>([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x!,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y!,'base64url'))]]));
 return{id:b64(id),registration(options:any,claimedOrigin=origin){const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:options.challenge,origin:claimedOrigin,crossOrigin:false}));const size=Buffer.alloc(2);size.writeUInt16BE(id.length);const auth=Buffer.concat([sha(options.rp.id),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),size,id,cose]);return{id:b64(id),rawId:b64(id),type:'public-key',response:{attestationObject:b64(isoCBOR.encode(new Map<any,any>([['fmt','none'],['attStmt',new Map()],['authData',new Uint8Array(auth)]]))),clientDataJSON:b64(client),transports:['internal']},clientExtensionResults:{credProps:{rk:true}}};},assertion(options:any,handle:string,counter=1,claimedOrigin=origin){const client=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin:claimedOrigin,crossOrigin:false})),count=Buffer.alloc(4);count.writeUInt32BE(counter);const auth=Buffer.concat([sha(options.rpId),Buffer.from([5]),count]);return{id:b64(id),rawId:b64(id),type:'public-key',response:{authenticatorData:b64(auth),clientDataJSON:b64(client),signature:b64(sign('sha256',Buffer.concat([auth,sha(client)]),pair.privateKey)),userHandle:handle},clientExtensionResults:{}};}};
}
async function enroll(browser:Browser,key=authenticator()){
 const response=await call(browser,'/account/passkeys/options',{});expect(response.status,await response.clone().text()).toBe(200);const options=await response.json()as any;
 const registered=await call(browser,'/account/passkeys/register',{challenge_id:options.challenge_id,credential:key.registration(options.options),name:'Synthetic passkey'});expect(registered.status,await registered.clone().text()).toBe(201);return{key,handle:options.options.user.id};
}
describe('account recovery and ownership in real workerd/D1',()=>{
 it('requires an authenticated owner for registration, recovery-key rotation and session management',async()=>{
  const anonymous={cookies:{}};for(const path of ['/account/security','/account/passkeys/options','/account/recovery-keys/rotate','/account/sessions/revoke-all'])expect((await call(anonymous,path,path.endsWith('security')?undefined:{})).status).toBe(401);
 });
 it('registers a real ES256 discoverable passkey and verifies a signed assertion from a fresh browser',async()=>{
  const{browser,user}=await owner();const{key,handle}=await enroll(browser);const fresh:Browser={cookies:{}};
  const options=await(await call(fresh,'/account/passkeys/login-options',{})).json()as any;
  const payload={challenge_id:options.challenge_id,credential:key.assertion(options.options,handle)};
  const signedIn=await call(fresh,'/account/passkeys/login-verify',payload);expect(signedIn.status,await signedIn.clone().text()).toBe(200);expect(await signedIn.json()).toEqual({authenticated:true,user_id:user.id});
  expect((await call(fresh,`/profile/${user.id}`)).status).toBe(200);expect((await call(fresh,'/account/passkeys/login-verify',payload)).status).toBe(401);
  expect((await db.prepare('SELECT counter FROM account_passkeys').first<any>())!.counter).toBe(1);
 });
 it('rejects forged signatures and cross-origin client data, consumes failed challenges, and never creates a session',async()=>{
  const{browser}=await owner();const{key,handle}=await enroll(browser);const fresh:Browser={cookies:{}};
  for(const badOrigin of [false,true]){const options=await(await call(fresh,'/account/passkeys/login-options',{})).json()as any;const credential=key.assertion(options.options,handle,1,badOrigin?'https://attacker.example':origin);if(!badOrigin)credential.response.signature=b64(randomBytes(70));const payload={challenge_id:options.challenge_id,credential};expect((await call(fresh,'/account/passkeys/login-verify',payload)).status).toBe(401);expect((await call(fresh,'/account/passkeys/login-verify',payload)).status).toBe(401);}
  expect(fresh.cookies.hireflow_session).toBeUndefined();
 });
 it('binds registration to its owner session and browser, rejecting cross-user challenge theft and expiry',async()=>{
  const first=await owner(),second=await owner('second@example.com'),key=authenticator();const options=await(await call(first.browser,'/account/passkeys/options',{})).json()as any;
  second.browser.cookies.hireflow_webauthn=first.browser.cookies.hireflow_webauthn;
  const payload={challenge_id:options.challenge_id,credential:key.registration(options.options)};
  expect((await call(second.browser,'/account/passkeys/register',payload)).status).toBe(401);
  expect((await call(first.browser,'/account/passkeys/register',payload)).status).toBe(201);
  const expired=await(await call(first.browser,'/account/passkeys/options',{})).json()as any;await db.prepare("UPDATE account_challenges SET expires_at='2000-01-01T00:00:00.000Z'").run();
  expect((await call(first.browser,'/account/passkeys/register',{challenge_id:expired.challenge_id,credential:authenticator().registration(expired.options)})).status).toBe(401);
 });
 it('stores recovery hashes only, rotates old keys, consumes one key atomically and revokes old sessions and transfers',async()=>{
  const{browser,user}=await owner();const first=await(await call(browser,'/account/recovery-keys/rotate',{})).json()as any;const rotated=await(await call(browser,'/account/recovery-keys/rotate',{})).json()as any;
  expect(rotated.recovery_keys).toHaveLength(8);const stored=await db.prepare('SELECT token_hash FROM account_recovery_keys').all<any>();expect(stored.results.every(row=>!JSON.stringify(rotated.recovery_keys).includes(row.token_hash))).toBe(true);
  expect((await call({cookies:{}},'/account/recover',{recovery_key:first.recovery_keys[0]})).status).toBe(401);
  const fresh:Browser={cookies:{}};const results=await Promise.all([call(fresh,'/account/recover',{recovery_key:rotated.recovery_keys[0]}),call({cookies:{}},'/account/recover',{recovery_key:rotated.recovery_keys[0]})]);expect(results.map(r=>r.status).sort()).toEqual([200,401]);
  expect((await call(browser,`/profile/${user.id}`)).status).toBe(401);expect((await db.prepare('SELECT count(*) AS n FROM sessions').first<any>())!.n).toBe(1);
 });
 it('lists and revokes only owned sessions/passkeys and revokes every current session on sign-out-all',async()=>{
  const first=await owner(),second=await owner('second@example.com');await enroll(first.browser);
  const own=await(await call(first.browser,'/account/security')).json()as any,foreign=await(await call(second.browser,'/account/security')).json()as any;
  expect(own.sessions[0].current).toBe(true);expect(JSON.stringify(own)).not.toContain('token_hash');expect((await call(second.browser,`/account/sessions/${own.sessions[0].id}`,undefined,'DELETE')).status).toBe(404);
  expect((await call(second.browser,`/account/passkeys/${own.passkeys[0].id}`,undefined,'DELETE')).status).toBe(404);
  expect((await call(first.browser,'/account/sessions/revoke-all',{})).status).toBe(200);expect((await call(first.browser,`/profile/${first.user.id}`)).status).toBe(401);
  expect((await call(second.browser,`/profile/${second.user.id}`)).status).toBe(200);expect(foreign.sessions).toHaveLength(1);
 });
 it('rolls recovery back when replacement-session storage fails, without spending the key or revoking the owner',async()=>{
  const{browser,user}=await owner();const keys=await(await call(browser,'/account/recovery-keys/rotate',{})).json()as any;
  await db.prepare("CREATE TRIGGER fail_recovery_session BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END").run();
  expect((await call({cookies:{}},'/account/recover',{recovery_key:keys.recovery_keys[0]})).status).toBe(503);
  expect((await call(browser,`/profile/${user.id}`)).status).toBe(200);expect((await db.prepare('SELECT count(*) AS n FROM account_recovery_keys WHERE used_at IS NOT NULL').first<any>())!.n).toBe(0);
  await db.prepare('DROP TRIGGER fail_recovery_session').run();expect((await call({cookies:{}},'/account/recover',{recovery_key:keys.recovery_keys[0]})).status).toBe(200);
 });
 it('rejects expired recovery keys, foreign origins and repeated brute-force attempts',async()=>{
  const{browser}=await owner();const keys=await(await call(browser,'/account/recovery-keys/rotate',{})).json()as any;
  await db.prepare("UPDATE account_recovery_keys SET expires_at='2000-01-01T00:00:00.000Z'").run();expect((await call({cookies:{}},'/account/recover',{recovery_key:keys.recovery_keys[0]})).status).toBe(401);
  expect((await call(browser,'/account/recovery-keys/rotate',{},'POST','https://attacker.example')).status).toBe(403);
  for(let i=0;i<9;i++)expect((await call({cookies:{}},'/account/recover',{recovery_key:'invalid'})).status).toBe(401);
  expect((await call({cookies:{}},'/account/recover',{recovery_key:'invalid'})).status).toBe(429);
 });
});
