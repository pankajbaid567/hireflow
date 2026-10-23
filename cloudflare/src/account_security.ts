import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse, type RegistrationResponseJSON, type AuthenticationResponseJSON } from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { ApiError, type Env, type Row, json, parsed } from './types';
import { digest, requireUser, sessionHash, startSession, prepareSession, logout } from './auth';
import { all, first, run } from './storage';
import { readJson } from './profile';

const invalidRecovery='This recovery key is invalid, expired or already used.';
const invalidPasskey='Passkey verification could not be completed. Please try again or use a recovery key.';
const randomToken=()=>Array.from(crypto.getRandomValues(new Uint8Array(32)),byte=>byte.toString(16).padStart(2,'0')).join('');
const challengeCookie='hireflow_webauthn';

function relyingParty(env:Env){
  let url:URL;
  try{url=new URL(env.PUBLIC_BASE_URL);}catch{throw new ApiError(503,'Account recovery is not configured.');}
  const local=['localhost','127.0.0.1'].includes(url.hostname);
  if(url.username||url.password||url.protocol!=='https:'&&!(local&&url.protocol==='http:'))throw new ApiError(503,'Account recovery is not configured.');
  const configured=(env.ALLOWED_ORIGINS||'').split(',').map(origin=>origin.trim());
  if(!configured.includes(url.origin))throw new ApiError(503,'Account recovery is not configured.');
  const rpID=env.WEBAUTHN_RP_ID || url.hostname;
  // Prevent a configuration mistake from accepting credentials for another RP.
  if(rpID!==url.hostname)throw new ApiError(503,'The passkey domain does not match this workspace.');
  return{origin:url.origin,rpID};
}
function requireOrigin(request:Request,env:Env){
  const rp=relyingParty(env);
  if(request.headers.get('origin')!==rp.origin)throw new ApiError(403,'Open account security on the workspace website.');
  return rp;
}
function ceremonyCookie(request:Request,token:string,maxAge=300){
  return `${challengeCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol==='https:'?'; Secure':''}`;
}
async function browserHash(request:Request){
  const token=request.headers.get('cookie')?.split(';').map(value=>value.trim()).find(value=>value.startsWith(`${challengeCookie}=`))?.slice(challengeCookie.length+1);
  return token&&/^[a-f0-9]{64}$/.test(token)?digest(token):null;
}
async function rateLimit(request:Request,env:Env,kind:string,maximum=10){
  const now=Date.now(),cutoff=now-600000;
  const key=`account:${kind}:${await digest(request.headers.get('cf-connecting-ip')||'local')}`;
  const row=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,
    window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    WHERE window_start<=? OR attempts<? RETURNING attempts`,key,now,cutoff,cutoff,cutoff,maximum);
  if(!row)throw new ApiError(429,'Too many recovery attempts. Please try again in 10 minutes.');
}
async function challengeOptions(request:Request,env:Env,purpose:'register'|'authenticate'){
  const rp=requireOrigin(request,env);await rateLimit(request,env,'options',30);
  const userId=purpose==='register'?await requireUser(request,env):null;
  let options;
  if(userId){
    const user=await first(env,'SELECT name,email FROM users WHERE id=?',userId);
    await run(env,'INSERT INTO account_owners(user_id,user_handle) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING',userId,isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))));
    const owner=await first(env,'SELECT user_handle FROM account_owners WHERE user_id=?',userId);
    const existing=await all(env,'SELECT id,transports FROM account_passkeys WHERE user_id=?',userId);
    if(existing.length>=10)throw new ApiError(409,'Remove an old passkey before adding another.');
    options=await generateRegistrationOptions({rpName:'HireFlow',rpID:rp.rpID,userName:user!.email,userDisplayName:user!.name,userID:isoBase64URL.toBuffer(owner!.user_handle),attestationType:'none',supportedAlgorithmIDs:[-7],authenticatorSelection:{residentKey:'required',userVerification:'required'},excludeCredentials:existing.map(key=>({id:key.id,transports:parsed(key.transports,[])}))});
  }else options=await generateAuthenticationOptions({rpID:rp.rpID,userVerification:'required',allowCredentials:[]});
  const id=crypto.randomUUID(),browserToken=randomToken();
  await run(env,`INSERT INTO account_challenges(id,purpose,user_id,session_hash,browser_hash,challenge,origin,rp_id,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`,id,purpose,userId,userId?await sessionHash(request):null,await digest(browserToken),options.challenge,rp.origin,rp.rpID,new Date(Date.now()+300000).toISOString());
  return json({challenge_id:id,options},200,{'Set-Cookie':ceremonyCookie(request,browserToken)});
}
async function takeChallenge(request:Request,env:Env,data:Row,purpose:'register'|'authenticate',userId:number|null){
  requireOrigin(request,env);
  const bound=await browserHash(request);
  if(typeof data.challenge_id!=='string'||data.challenge_id.length>80||!bound)throw new ApiError(401,invalidPasskey);
  // Failed verification also consumes the challenge. Another owner/browser
  // cannot consume a registration challenge belonging to this session.
  const row=await first(env,`DELETE FROM account_challenges WHERE id=? AND purpose=? AND browser_hash=? AND expires_at>?
    AND (? IS NULL OR (user_id=? AND session_hash=?)) RETURNING *`,data.challenge_id,purpose,bound,new Date().toISOString(),userId,userId,userId?await sessionHash(request):null);
  if(!row)throw new ApiError(401,invalidPasskey);
  return row;
}
async function register(request:Request,env:Env){
  const userId=await requireUser(request,env),data=await readJson(request);
  const challenge=await takeChallenge(request,env,data,'register',userId);
  let verified;
  try{verified=await verifyRegistrationResponse({response:data.credential as RegistrationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:challenge.origin,expectedRPID:challenge.rp_id,requireUserVerification:true,supportedAlgorithmIDs:[-7]});}
  catch{throw new ApiError(401,invalidPasskey);}
  if(!verified.verified||!verified.registrationInfo)throw new ApiError(401,invalidPasskey);
  const credential=verified.registrationInfo.credential;
  const name=typeof data.name==='string'?data.name.trim().slice(0,80):'';
  const saved=await first(env,`INSERT INTO account_passkeys(id,user_id,public_key,counter,transports,name,created_at)
    SELECT ?,?,?,?,?,?,? WHERE (SELECT count(*) FROM account_passkeys WHERE user_id=?)<10
    ON CONFLICT(id) DO NOTHING RETURNING id`,credential.id,userId,isoBase64URL.fromBuffer(credential.publicKey),credential.counter,JSON.stringify(credential.transports||[]),name||'Passkey',new Date().toISOString(),userId);
  if(!saved)throw new ApiError(409,'This passkey is already registered or the account limit was reached.');
  return json({registered:true},201,{'Set-Cookie':ceremonyCookie(request,'',0)});
}
async function authenticate(request:Request,env:Env){
  requireOrigin(request,env);await rateLimit(request,env,'passkey');
  const data=await readJson(request),challenge=await takeChallenge(request,env,data,'authenticate',null);
  const id=data.credential?.id;
  if(typeof id!=='string'||id.length>2048)throw new ApiError(401,invalidPasskey);
  const key=await first(env,'SELECT p.*,o.user_handle FROM account_passkeys p JOIN account_owners o ON o.user_id=p.user_id WHERE p.id=?',id);
  if(!key)throw new ApiError(401,invalidPasskey);
  const handle=data.credential?.response?.userHandle;
  if(handle&&handle!==key.user_handle)throw new ApiError(401,invalidPasskey);
  let verified;
  try{verified=await verifyAuthenticationResponse({response:data.credential as AuthenticationResponseJSON,expectedChallenge:challenge.challenge,expectedOrigin:challenge.origin,expectedRPID:challenge.rp_id,requireUserVerification:true,credential:{id:key.id,publicKey:isoBase64URL.toBuffer(key.public_key),counter:key.counter,transports:parsed(key.transports,[])}});}
  catch{throw new ApiError(401,invalidPasskey);}
  if(!verified.verified)throw new ApiError(401,invalidPasskey);
  const saved=await first(env,'UPDATE account_passkeys SET counter=?,last_used_at=? WHERE id=? AND counter=? RETURNING user_id',verified.authenticationInfo.newCounter,new Date().toISOString(),key.id,key.counter);
  if(!saved)throw new ApiError(409,'This passkey changed. Please try again.');
  return json({authenticated:true,user_id:key.user_id},200,{'Set-Cookie':await startSession(request,env,key.user_id)});
}
async function rotateRecoveryKeys(request:Request,env:Env){
  requireOrigin(request,env);const userId=await requireUser(request,env);
  const keys=Array.from({length:8},()=>`hf-recovery-${randomToken()}`),created=new Date().toISOString(),expires=new Date(Date.now()+365*86400000).toISOString();
  const hashes=await Promise.all(keys.map(digest));
  await env.DB.batch([env.DB.prepare('DELETE FROM account_recovery_keys WHERE user_id=?').bind(userId),...hashes.map(hash=>env.DB.prepare('INSERT INTO account_recovery_keys(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)').bind(hash,userId,created,expires))]);
  return json({recovery_keys:keys,expires_at:expires});
}
async function recover(request:Request,env:Env){
  requireOrigin(request,env);await rateLimit(request,env,'recovery');
  const data=await readJson(request),key=typeof data.recovery_key==='string'?data.recovery_key.trim():'';
  if(!/^hf-recovery-[a-f0-9]{64}$/.test(key))throw new ApiError(401,invalidRecovery);
  const hash=await digest(key),timestamp=new Date().toISOString();
  const row=await first(env,'SELECT user_id FROM account_recovery_keys WHERE token_hash=? AND used_at IS NULL AND expires_at>?',hash,timestamp);
  if(!row)throw new ApiError(401,invalidRecovery);
  const session=await prepareSession(request,env,row.user_id);
  const claimed='EXISTS(SELECT 1 FROM account_recovery_keys WHERE token_hash=? AND used_session_id=?)';
  // Consuming the key, revoking lost devices, and creating the replacement
  // session commit together. Storage errors leave the key and old sessions
  // intact. A unique claim ID also makes concurrent recovery one-winner-only.
  const result=await env.DB.batch([
    env.DB.prepare('UPDATE account_recovery_keys SET used_at=?,used_session_id=? WHERE token_hash=? AND used_at IS NULL AND expires_at>? RETURNING user_id').bind(timestamp,session.id,hash,timestamp),
    env.DB.prepare(`DELETE FROM sessions WHERE user_id=? AND ${claimed}`).bind(row.user_id,hash,session.id),
    env.DB.prepare(`DELETE FROM session_transfers WHERE user_id=? AND ${claimed}`).bind(row.user_id,hash,session.id),
    env.DB.prepare(`DELETE FROM account_challenges WHERE user_id=? AND ${claimed}`).bind(row.user_id,hash,session.id),
    env.DB.prepare(`INSERT INTO sessions(token_hash,user_id,expires_at,id,created_at,label) SELECT ?,?,?,?,?,? WHERE ${claimed} RETURNING id`).bind(session.token_hash,session.user_id,session.expires_at,session.id,session.created_at,session.label,hash,session.id),
  ]);
  if(!result[0].results.length||!result[4].results.length)throw new ApiError(401,invalidRecovery);
  return json({authenticated:true,user_id:row.user_id},200,{'Set-Cookie':session.cookie});
}

/** Root router calls this after its CORS guard; unmatched routes return null. */
export async function accountSecurity(request:Request,env:Env):Promise<Response|null>{
  const path=new URL(request.url).pathname.replace(/\/$/,''),method=request.method;
  if(!path.startsWith('/account/'))return null;
  if(method==='POST'&&path==='/account/passkeys/login-options')return challengeOptions(request,env,'authenticate');
  if(method==='POST'&&path==='/account/passkeys/login-verify')return authenticate(request,env);
  if(method==='POST'&&path==='/account/recover')return recover(request,env);
  const userId=await requireUser(request,env);
  if(method==='GET'&&path==='/account/security'){
    const current=await sessionHash(request),now=new Date().toISOString();
    // Read the three owner-scoped lists in one D1 call/snapshot. Profiling the
    // previous sequential reads showed repeated fetch/span/result conversion
    // overhead; batching does not cache credentials or skip authorization.
    const result=await env.DB.batch<Row>([
      env.DB.prepare('SELECT id,label,created_at,expires_at,token_hash FROM sessions WHERE user_id=? AND expires_at>? ORDER BY created_at DESC').bind(userId,now),
      env.DB.prepare('SELECT id,name,created_at,last_used_at FROM account_passkeys WHERE user_id=? ORDER BY created_at').bind(userId),
      env.DB.prepare('SELECT count(*) AS remaining,min(expires_at) AS expires_at FROM account_recovery_keys WHERE user_id=? AND used_at IS NULL AND expires_at>?').bind(userId,now),
    ]);
    const sessions=result[0].results,passkeys=result[1].results,keys=result[2].results[0];
    return json({sessions:sessions.map(({token_hash,...session})=>({...session,current:token_hash===current})),passkeys,recovery_keys:keys});
  }
  requireOrigin(request,env);
  if(method==='POST'&&path==='/account/passkeys/options')return challengeOptions(request,env,'register');
  if(method==='POST'&&path==='/account/passkeys/register')return register(request,env);
  if(method==='POST'&&path==='/account/recovery-keys/rotate')return rotateRecoveryKeys(request,env);
  if(method==='POST'&&path==='/account/sessions/revoke-all'){
    await env.DB.batch([env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(userId),env.DB.prepare('DELETE FROM session_transfers WHERE user_id=?').bind(userId),env.DB.prepare('DELETE FROM account_challenges WHERE user_id=?').bind(userId)]);
    return logout(request,env);
  }
  const key=path.match(/^\/account\/passkeys\/([A-Za-z0-9_-]{1,2048})$/);
  if(method==='DELETE'&&key){const removed=await first(env,'DELETE FROM account_passkeys WHERE id=? AND user_id=? RETURNING id',key[1],userId);if(!removed)throw new ApiError(404,'Passkey not found.');return json({deleted:true});}
  const session=path.match(/^\/account\/sessions\/([a-f0-9-]{32,36})$/);
  if(method==='DELETE'&&session){const removed=await first(env,'DELETE FROM sessions WHERE id=? AND user_id=? RETURNING token_hash',session[1],userId);if(!removed)throw new ApiError(404,'Session not found.');return removed.token_hash===await sessionHash(request)?logout(request,env):json({revoked:true});}
  return json({detail:'Account route not found.'},404);
}

export async function cleanupAccountSecurity(env:Env){
  await env.DB.batch([env.DB.prepare('DELETE FROM account_challenges WHERE expires_at<?').bind(new Date().toISOString()),env.DB.prepare('DELETE FROM account_recovery_keys WHERE expires_at<?').bind(new Date().toISOString())]);
}
