/** Local-only real browser/passkey recovery verification. No remote credentials. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../cloudflare/package.json',import.meta.url));
const {buildSync}=require('esbuild'),{Miniflare,convertV4MiniflareOptions}=require('miniflare'),{unstable_splitSqlQuery}=require('wrangler'),{chromium}=require('playwright-core');
const site='http://localhost:3119',backend='http://127.0.0.1:8799',code='local-account-security-synthetic-code';
let mf,vite,browser;
const errors=[];
async function authenticator(context,page,credentials=[]){
 const cdp=await context.newCDPSession(page);await cdp.send('WebAuthn.enable');
 const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 for(const credential of credentials)await cdp.send('WebAuthn.addCredential',{authenticatorId,credential});
 return{cdp,authenticatorId};
}
async function pageIn(context){const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(`${site}/profile`);return page;}
async function openRecovery(page){if(!await page.getByRole('heading',{name:'Recover your workspace'}).isVisible())await page.getByText('Already have a workspace? Sign in',{exact:true}).click();await page.getByRole('heading',{name:'Recover your workspace'}).waitFor();}
try{
 const script=buildSync({entryPoints:[`${root}cloudflare/src/index.ts`],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script,port:8799,host:'127.0.0.1',cf:false,logRequests:false,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],kvNamespaces:['FILES_KV'],queueProducers:{APPLICATION_QUEUE:'local-account-security'},bindings:{ACCESS_CODE:code,ALLOWED_ORIGINS:site,PUBLIC_BASE_URL:`${site}/api`,BROWSER_ENABLED:'false'}}));
 const db=await mf.getD1Database('DB');for(const file of readdirSync(`${root}cloudflare/migrations`).filter(name=>/^\d+.*\.sql$/.test(name)).sort())await db.batch(unstable_splitSqlQuery(readFileSync(`${root}cloudflare/migrations/${file}`,'utf8')).map(query=>db.prepare(query)));await mf.ready;
 vite=spawn(process.execPath,[`${root}frontend/node_modules/vite/bin/vite.js`,'--host','localhost','--port','3119','--strictPort'],{cwd:`${root}frontend`,stdio:['ignore','pipe','pipe'],env:{...process.env,VITE_DEPLOYMENT_TARGET:'cloudflare',VITE_API_URL:'/api',API_PROXY_TARGET:backend,WORKSPACE_ACCESS_CODE:code}});
 let started=false;for(let attempt=0;attempt<150;attempt++){try{if((await fetch(site)).ok){started=true;break;}}catch{}await pause(200);}assert(started,'Local dashboard did not start');
 browser=await chromium.launch({headless:true});
 const first=await browser.newContext(),page=await pageIn(first);const virtual=await authenticator(first,page);
 await page.getByLabel('Full name',{exact:true}).fill('Passkey QA Owner');await page.getByLabel('Email address',{exact:true}).fill('local-passkey-owner@example.com');await page.getByRole('button',{name:'Save profile',exact:true}).click();await page.getByRole('heading',{name:'Account security and recovery'}).waitFor();
 const initial=await(await first.request.get(`${site}/api/session`)).json();assert(initial.authenticated);
 await page.getByRole('button',{name:'Add a passkey',exact:true}).click();await page.getByText(/^Passkey added\./).waitFor();
 const {credentials}=await virtual.cdp.send('WebAuthn.getCredentials',{authenticatorId:virtual.authenticatorId});assert.equal(credentials.length,1);
 // A second device receives the same synthetic resident passkey, as a synced
 // passkey provider would. It has no copied site cookie or session token.
 const second=await browser.newContext(),secondPage=await pageIn(second);await authenticator(second,secondPage,credentials);
 assert.equal((await(await second.request.get(`${site}/api/session`)).json()).authenticated,false);
 await openRecovery(secondPage);
 await secondPage.getByRole('button',{name:'Continue with a passkey',exact:true}).click();await secondPage.getByRole('heading',{name:'Account security and recovery'}).waitFor();
 const recovered=await(await second.request.get(`${site}/api/session`)).json();assert.equal(recovered.user_id,initial.user_id);
 await page.getByRole('button',{name:'Generate recovery keys',exact:true}).click();const raw=await page.getByLabel('Recovery keys to save').inputValue();const keys=raw.split('\n');assert.equal(keys.length,8);await page.getByRole('button',{name:'I saved these keys'}).click();assert.equal(await page.getByLabel('Recovery keys to save').count(),0);
 const third=await browser.newContext(),thirdPage=await pageIn(third);await openRecovery(thirdPage);await thirdPage.getByLabel('Recovery key',{exact:true}).fill(keys[0]);await thirdPage.getByRole('button',{name:'Use recovery key',exact:true}).click();await thirdPage.getByRole('heading',{name:'Account security and recovery'}).waitFor();
 assert.equal((await(await third.request.get(`${site}/api/session`)).json()).user_id,initial.user_id);
 for(const old of [first,second])assert.equal((await old.request.get(`${site}/api/profile/${initial.user_id}`)).status(),401);
 const replay=await third.request.post(`${site}/api/account/recover`,{headers:{Origin:site},data:{recovery_key:keys[0]}});assert.equal(replay.status(),401);
 const security=await(await third.request.get(`${site}/api/account/security`)).json();assert.equal(security.recovery_keys.remaining,7);assert.equal(security.sessions.length,1);
 await thirdPage.getByRole('button',{name:'Sign out all devices',exact:true}).click();await openRecovery(thirdPage);assert.equal((await third.request.get(`${site}/api/profile/${initial.user_id}`)).status(),401);
 assert.deepEqual(errors,[]);console.log(JSON.stringify({local_only:true,passkey_registration:true,second_device_signed_assertion_login:true,recovery_key_new_browser:true,key_replay_rejected:true,old_sessions_revoked:true,revoke_all:true,browser_runtime_errors:0}));
}finally{await browser?.close();vite?.kill('SIGTERM');await mf?.dispose();}
