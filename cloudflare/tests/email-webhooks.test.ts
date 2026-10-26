/** Actual workerd/D1; cryptographic fixtures and provider writes stay local. */
import {afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {createHash,createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {buildSync} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {applyTestMigrations} from './migrations';
const root=fileURLToPath(new URL('../',import.meta.url));
const secret='whsec_'+Buffer.from('isolated-signature-key-32-bytes!!').toString('base64');
const signing=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=signing.publicKey.export({type:'spki',format:'der'}).toString('base64');
const owner='receipt-owner@example.com',deliveryId='12345678-1234-4123-8123-123456789abc',secondId='22345678-1234-4123-8123-123456789abc';
let bundle:string,mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>,bucket:Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let providerCalls:number,gate:{entered:Promise<void>;wait:Promise<void>;notify:()=>void;release:()=>void}|null;
const harness=`import {receiveEmailWebhook,verifyEmailSignature} from './src/email_webhooks';import {deliveryMetadata,processEmailDelivery,recoverEmailDeliveries} from './src/email_delivery';import {ApiError} from './src/types';export default{async fetch(request,env){try{const url=new URL(request.url),path=url.pathname;if(path.startsWith('/signature/')){const provider=path.split('/')[2],bound={...env};if(url.searchParams.has('vector')){if(provider==='resend')bound.RESEND_WEBHOOK_SECRET='whsec_plJ3nmyCDGBKInavdOK15jsl';else bound.SENDGRID_WEBHOOK_PUBLIC_KEY='MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==';}await verifyEmailSignature(provider,new Uint8Array(await request.arrayBuffer()),request.headers,bound,Number(url.searchParams.get('now')||Date.now()));return Response.json({verified:true});}if(path.startsWith('/webhook/')){const bound={...env};if(url.searchParams.has('missing')){delete bound.RESEND_WEBHOOK_SECRET;delete bound.SENDGRID_WEBHOOK_PUBLIC_KEY;}return await receiveEmailWebhook(request,bound,path.split('/')[2]);}if(path.startsWith('/status/')){const row=await env.DB.prepare('SELECT * FROM email_deliveries WHERE id=?').bind(path.split('/')[2]).first();return Response.json(deliveryMetadata(row));}if(path.startsWith('/send/')){await processEmailDelivery(env,path.split('/')[2]);return Response.json({done:true});}if(path==='/recover'){await recoverEmailDeliveries(env);return Response.json({done:true});}return new Response(null,{status:404});}catch(error){return Response.json({detail:error instanceof ApiError?error.message:'Controlled fixture failure'},{status:error instanceof ApiError?error.status:500});}}};`;
beforeAll(()=>{bundle=buildSync({stdin:{contents:harness,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
beforeEach(async()=>{
 providerCalls=0;gate=null;
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'receipt-fixture'},bindings:{RESEND_WEBHOOK_SECRET:secret,SENDGRID_WEBHOOK_PUBLIC_KEY:publicKey,EMAIL_PROVIDER:'resend',RESEND_API_KEY:'fixture-provider-key',FROM_EMAIL:'weekly@hireflow.test'},outboundService:async request=>{if(request.url!=='https://api.resend.com/emails')throw new Error('Unexpected outbound request');providerCalls++;if(gate){gate.notify();await gate.wait;}return Response.json({id:'resend-message-1'});}}));
 db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
 await db.prepare("INSERT INTO users(id,name,email,mode) VALUES(1,'Receipt fixture',?,'internship')").bind(owner).run();
 await db.prepare("INSERT INTO weekly_reports(id,user_id,week_start_date,content,metrics,applied_count,avg_match_score,html_path) VALUES(1,1,'2026-10-26','{}','{}',0,0,'reports/1/version-a.html')").run();
},30000);
afterEach(async()=>{gate?.release();await mf?.dispose();},30000);
async function seed(provider='resend',id=deliveryId,options:{state?:string;message?:string|null;first?:string|null;accepted?:string|null;attempts?:number;payloadHash?:string}={}){
 const created=new Date(Date.now()-600000).toISOString(),first=options.first===undefined?new Date(Date.now()-10000).toISOString():options.first;
 await db.prepare(`INSERT INTO email_deliveries(id,user_id,report_id,report_key,provider,recipient,sender,subject,payload_key,payload_hash,source_artifacts,source_snapshot,idempotency_key,state,attempts,provider_message_id,first_attempt_at,accepted_at,created_at,expires_at) VALUES(?,1,1,?,?,?,'weekly@hireflow.test','Fixture report',?,?,'[]','{}',?,?,?,?,?,?,?,?)`).bind(id,id===deliveryId?'reports/1/version-a.html':`reports/1/${id}.html`,provider,owner,`mail/1/${id}/payload.json`,options.payloadHash||'fixture-hash',`fixture/${id}`,options.state||'accepted',options.attempts??1,options.message===undefined?(provider==='resend'?'resend-message-1':'sendgrid-message-1'):options.message,first,options.accepted===undefined?first:options.accepted,created,new Date(Date.now()+86400000).toISOString()).run();
}
const at=(seconds=0)=>new Date(Date.now()+seconds*1000).toISOString();
function resend(type='email.delivered',options:Record<string,unknown>={}){return{type,created_at:at(),data:{email_id:'resend-message-1',to:[owner],tags:{hireflow_delivery_id:deliveryId},...options}};}
function sg(event='delivered',options:Record<string,unknown>={}){return{event,email:owner,timestamp:Math.floor(Date.now()/1000),sg_event_id:'sg-event-'+crypto.randomUUID(),sg_message_id:'sendgrid-message-1',hireflow_delivery_id:deliveryId,...options};}
function signed(provider:'resend'|'sendgrid',raw:string,options:{id?:string;time?:string;signature?:string}={}){
 const time=options.time||String(Math.floor(Date.now()/1000)),headers=new Headers({'Content-Type':'application/json'});
 if(provider==='resend'){const id=options.id||'msg_'+crypto.randomUUID();headers.set('svix-id',id);headers.set('svix-timestamp',time);headers.set('svix-signature',options.signature||'v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${time}.${raw}`).digest('base64'));}
 else{headers.set('x-twilio-email-event-webhook-timestamp',time);headers.set('x-twilio-email-event-webhook-signature',options.signature||sign('sha256',Buffer.from(time+raw),signing.privateKey).toString('base64'));}
 return headers;
}
async function post(provider:'resend'|'sendgrid',payload:unknown,options:{raw?:string;headers?:Headers;query?:string}={}){const raw=options.raw??JSON.stringify(payload);return mf.dispatchFetch(`https://receipt.fixture.example/webhook/${provider}${options.query||''}`,{method:'POST',headers:Object.fromEntries(options.headers||signed(provider,raw)),body:raw});}
async function status(id=deliveryId){return(await mf.dispatchFetch('https://receipt.fixture.example/status/'+id)).json() as Promise<Record<string,any>>;}
async function events(){return(await db.prepare('SELECT * FROM email_receipt_events ORDER BY occurred_at,event_id_hash').all<Record<string,any>>()).results;}
describe('verified provider delivery outcomes',()=>{
 it.each(['resend','sendgrid'] as const)('records %s delivery separately from API acceptance and never sends another email',async provider=>{
  await seed(provider);const accepted=await status();expect(accepted).toMatchObject({state:'accepted',delivery_status:null,delivered_at:null});
  const response=await post(provider,provider==='resend'?resend():[sg()]);expect(response.status,await response.clone().text()).toBe(200);
  expect(await status()).toMatchObject({state:'accepted',delivery_status:'delivered',delivery_evidence:'signed_provider_webhook'});expect((await status()).delivered_at).toBeTruthy();expect(await events()).toHaveLength(1);expect(providerCalls).toBe(0);
 });
 it.each(['resend','sendgrid'] as const)('keeps %s sent/processed evidence distinct from delivery',async provider=>{
  await seed(provider);const accepted=(await status()).accepted_at;await db.prepare('UPDATE weekly_reports SET email_sent_at=? WHERE id=1').bind(accepted).run();expect((await post(provider,provider==='resend'?resend('email.sent'):[sg('processed')])).status).toBe(200);expect(await status()).toMatchObject({state:'accepted',delivery_status:'accepted',accepted_at:accepted,delivered_at:null});expect((await db.prepare('SELECT email_sent_at FROM weekly_reports WHERE id=1').first<any>())!.email_sent_at).toBe(accepted);
 });
 it.each(['resend','sendgrid'] as const)('fills missing %s acceptance timestamps from older signed acceptance without erasing a later bounce',async provider=>{
  await seed(provider,deliveryId,{state:'sending',accepted:null});const seconds=Math.floor(Date.now()/1000)-3,accepted=new Date(seconds*1000).toISOString();
  const bounce=provider==='resend'?{...resend('email.bounced'),created_at:new Date((seconds+1)*1000).toISOString()}:[sg('bounce',{timestamp:seconds+1})];expect((await post(provider,bounce)).status).toBe(200);expect((await status()).accepted_at).toBeNull();expect((await db.prepare('SELECT email_sent_at FROM weekly_reports WHERE id=1').first<any>())!.email_sent_at).toBeNull();
  const sent=provider==='resend'?{...resend('email.sent'),created_at:accepted}:[sg('processed',{timestamp:seconds})];expect((await post(provider,sent)).status).toBe(200);expect(await status()).toMatchObject({state:'accepted',delivery_status:'bounced',accepted_at:accepted,delivered_at:null});const report=(await db.prepare('SELECT email_sent_at,email_failure_reason FROM weekly_reports WHERE id=1').first<any>())!;expect(report.email_sent_at).toBe(accepted);expect(report.email_failure_reason).toContain('rejected');expect(providerCalls).toBe(0);
 });
 it('deduplicates identical retries and concurrent deliveries without changing owner revisions',async()=>{
  await seed();const raw=JSON.stringify(resend()),headers=signed('resend',raw,{id:'msg_stable'});const responses=await Promise.all([post('resend',null,{raw,headers}),post('resend',null,{raw,headers})]);expect(responses.map(r=>r.status)).toEqual([200,200]);const before=(await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision;
  expect((await post('resend',null,{raw,headers})).status).toBe(200);expect(await events()).toHaveLength(1);expect((await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision).toBe(before);
 });
 it('rejects an authenticated event identifier reused with a changed outcome',async()=>{
  await seed();const first=JSON.stringify(resend()),second=JSON.stringify(resend('email.bounced'));await post('resend',null,{raw:first,headers:signed('resend',first,{id:'msg_reused'})});
  const response=await post('resend',null,{raw:second,headers:signed('resend',second,{id:'msg_reused'})});expect(response.status).toBe(409);expect((await status()).delivery_status).toBe('delivered');expect(await events()).toHaveLength(1);
 });
 it('rejects conflicting duplicate event IDs within one signed SendGrid batch atomically',async()=>{
  await seed('sendgrid');const a=sg('delivered',{sg_event_id:'same-event'}),b={...a,event:'bounce'};expect((await post('sendgrid',[a,b])).status).toBe(409);expect(await events()).toHaveLength(0);
 });
 it('acknowledges identical duplicate event IDs inside one signed batch once',async()=>{
  await seed('sendgrid');const event=sg();expect((await post('sendgrid',[event,event])).status).toBe(200);expect(await events()).toHaveLength(1);
 });
 it('does not downgrade a delivered outcome for newer sent/delayed events or older failures',async()=>{
  await seed();const delivered=resend();delivered.created_at=at(-3);await post('resend',delivered);
  const accepted=resend('email.sent');accepted.created_at=at(-2);await post('resend',accepted);const delayed=resend('email.delivery_delayed');delayed.created_at=at(-1);await post('resend',delayed);const oldFailure=resend('email.bounced');oldFailure.created_at=at(-4);await post('resend',oldFailure);
  expect(await status()).toMatchObject({delivery_status:'delivered',delivered_at:delivered.created_at,failure_reason:null});expect(await events()).toHaveLength(4);
 });
 it('invalidates a deletion preview for new historical evidence and prevents receipt mutation',async()=>{
  await seed();const delivered=resend();delivered.created_at=at(-2);await post('resend',delivered);const before=(await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision;
  const older=resend('email.sent');older.created_at=at(-3);await post('resend',older);expect((await status()).delivery_status).toBe('delivered');expect((await db.prepare('SELECT revision FROM workspace_revisions WHERE user_id=1').first<any>())!.revision).toBeGreaterThan(before);await expect(db.prepare("UPDATE email_receipt_events SET outcome='failed'").run()).rejects.toThrow(/immutable/);
 });
 it('preserves delivery history when a later bounce or spam complaint arrives',async()=>{
  await seed();const delivered=resend();delivered.created_at=at(-3);await post('resend',delivered);const bounced=resend('email.bounced');bounced.created_at=at(-2);await post('resend',bounced);expect(await status()).toMatchObject({delivery_status:'bounced',delivered_at:delivered.created_at});
  const complaint=resend('email.complained');complaint.created_at=at(-1);await post('resend',complaint);await post('resend',resend());expect((await status()).delivery_status).toBe('complained');expect((await status()).failure_reason).toContain('spam');
 });
 it('surfaces a bounce on an ambiguous whole-second delivery tie while retaining delivery evidence',async()=>{
  await seed('sendgrid');const time=Math.floor(Date.now()/1000)-1;await post('sendgrid',[sg('bounce',{timestamp:time}),sg('delivered',{timestamp:time})]);expect(await status()).toMatchObject({delivery_status:'bounced',delivered_at:new Date(time*1000).toISOString()});
 });
 it('updates only the exact immutable weekly report version',async()=>{
  await seed();await db.prepare("UPDATE weekly_reports SET html_path='reports/1/version-b.html',email_failure_reason='New report version' WHERE id=1").run();await post('resend',resend('email.bounced'));
  await post('resend',resend('email.sent'));expect(await db.prepare('SELECT email_failure_reason,email_sent_at FROM weekly_reports WHERE id=1').first<any>()).toMatchObject({email_failure_reason:'New report version',email_sent_at:null});expect((await status()).delivery_status).toBe('bounced');
 });
 it('fails closed for altered raw bytes, stale/future timestamps, wrong signatures and missing setup',async()=>{
  await seed();const raw=JSON.stringify(resend()),headers=signed('resend',raw);
  expect((await post('resend',null,{raw:raw+' ',headers})).status).toBe(401);
  for(const seconds of [-601,601])expect((await post('resend',null,{raw,headers:signed('resend',raw,{time:String(Math.floor(Date.now()/1000)+seconds)})})).status).toBe(401);
  expect((await post('resend',null,{raw,headers:signed('resend',raw,{signature:'v1,'+Buffer.alloc(32).toString('base64')})})).status).toBe(401);expect((await post('resend',null,{raw,query:'?missing=1'})).status).toBe(503);expect(await events()).toHaveLength(0);
 });
 it('binds the actual recipient and provider message, including the correlation UUID',async()=>{
  await seed();await seed('resend',secondId,{message:'second-message'});
  for(const data of [{to:['different@example.com']},{email_id:'wrong-provider-message'},{tags:{hireflow_delivery_id:secondId}}])expect((await post('resend',resend('email.delivered',data))).status).toBe(200);
  expect(await events()).toHaveLength(0);expect((await status()).delivered_at).toBeNull();expect((await status(secondId)).delivered_at).toBeNull();
 });
 it('cannot apply another owner\'s message to the first workspace',async()=>{
  await seed();await db.prepare("INSERT INTO users(id,name,email,mode) VALUES(2,'Other receipt fixture','other-owner@example.com','job')").run();await db.prepare("INSERT INTO weekly_reports(id,user_id,week_start_date,content,metrics,applied_count,avg_match_score,html_path) VALUES(2,2,'2026-10-26','{}','{}',0,0,'reports/2/version-a.html')").run();
  const copy:Record<string,any>={...(await db.prepare('SELECT * FROM email_deliveries WHERE id=?').bind(deliveryId).first<Record<string,any>>())!,id:secondId,user_id:2,report_id:2,report_key:'reports/2/version-a.html',recipient:'other-owner@example.com',payload_key:'mail/2/other/payload.json',provider_message_id:'other-message',idempotency_key:'fixture/other'};const columns=Object.keys(copy);await db.prepare(`INSERT INTO email_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(key=>copy[key])).run();
  await post('resend',resend('email.delivered',{email_id:'other-message',tags:{hireflow_delivery_id:secondId}}));expect(await events()).toHaveLength(0);
  await post('resend',resend('email.delivered',{email_id:'other-message',to:['other-owner@example.com'],tags:{hireflow_delivery_id:secondId}}));expect((await status()).delivered_at).toBeNull();expect((await status(secondId)).delivery_status).toBe('delivered');
 });
 it('does not apply even a valid signed receipt to a request that never started a provider attempt',async()=>{
  await seed('resend',deliveryId,{state:'queued',first:null,attempts:0,message:null});expect((await post('resend',resend())).status).toBe(200);expect(await events()).toHaveLength(0);expect((await status()).state).toBe('queued');
 });
 it('accepts a legacy Resend receipt by its exact persisted provider ID without a tag',async()=>{
  await seed();expect((await post('resend',resend('email.delivered',{tags:{}}))).status).toBe(200);expect((await status()).delivery_status).toBe('delivered');
 });
 it('correlates SendGrid full event IDs without treating its API X-Message-ID as the same identifier',async()=>{
  await seed('sendgrid');expect((await post('sendgrid',[sg('delivered',{sg_message_id:'sendgrid-message-1.filterdrecv-123.0'})])).status).toBe(200);expect((await status()).delivery_status).toBe('delivered');
 });
 it('handles a SendGrid asynchronous bounce lacking sg_message_id only with its signed correlation tag',async()=>{
  await seed('sendgrid');expect((await post('sendgrid',[sg('bounce',{sg_message_id:undefined})])).status).toBe(200);expect((await status()).delivery_status).toBe('bounced');
 });
 it.each(['email.bounced','email.sent','email.delivered'])('handles %s before the provider HTTP response without resending or overwriting it',async type=>{
  const payload=JSON.stringify({from:'weekly@hireflow.test',to:[owner],subject:'Fixture report',html:'<p>Private report</p>',tags:[{name:'hireflow_delivery_id',value:deliveryId}]});
  await seed('resend',deliveryId,{state:'ready',first:null,attempts:0,message:null,payloadHash:createHash('sha256').update(payload).digest('hex')});await bucket.put(`mail/1/${deliveryId}/payload.json`,payload);
  let notify!:()=>void,release!:()=>void;gate={entered:new Promise<void>(r=>{notify=r;}),wait:new Promise<void>(r=>{release=r;}),notify:()=>notify(),release:()=>release()};const work=mf.dispatchFetch('https://receipt.fixture.example/send/'+deliveryId,{method:'POST'});await gate.entered;
  const receipt=resend(type);expect((await post('resend',receipt)).status).toBe(200);if(type==='email.sent'){const bounce=resend('email.bounced');bounce.created_at=new Date(Date.parse(receipt.created_at)+1000).toISOString();expect((await post('resend',bounce)).status).toBe(200);}gate.release();expect((await work).status).toBe(200);expect(await status()).toMatchObject({state:'accepted',delivery_status:type==='email.delivered'?'delivered':'bounced',accepted_at:type==='email.sent'?receipt.created_at:null,delivered_at:type==='email.delivered'?receipt.created_at:null,provider_message_id:null});
  await mf.dispatchFetch('https://receipt.fixture.example/recover',{method:'POST'});await mf.dispatchFetch('https://receipt.fixture.example/send/'+deliveryId,{method:'POST'});expect(providerCalls).toBe(1);const report=(await db.prepare('SELECT email_failure_reason,email_sent_at FROM weekly_reports WHERE id=1').first<any>())!;expect(report.email_sent_at).toBe(type==='email.sent'?receipt.created_at:null);if(type==='email.delivered')expect(report.email_failure_reason).toBeNull();else expect(report.email_failure_reason).toContain('rejected');
 });
 it('does not retain provider diagnostics, tracking addresses, raw event IDs or webhook bodies',async()=>{
  await seed('sendgrid');const event=sg('bounce',{sg_event_id:'sensitive-raw-event-id',reason:'secret-provider-diagnostic',ip:'203.0.113.73',useragent:'private-user-agent'});await post('sendgrid',[event]);const serialized=JSON.stringify(await events());
  for(const value of [owner,'secret-provider-diagnostic','sensitive-raw-event-id','203.0.113.73','private-user-agent','sg_message_id'])expect(serialized).not.toContain(value);expect((await status()).failure_reason).not.toContain('secret-provider-diagnostic');
 });
 it('cascades the receipt ledger on scoped owner deletion and ignores late signed receipts',async()=>{
  await seed();await post('resend',resend());expect(await events()).toHaveLength(1);await db.prepare('DELETE FROM users WHERE id=1').run();expect(await events()).toHaveLength(0);expect((await post('resend',resend())).status).toBe(200);expect(await events()).toHaveLength(0);
 });
 it('ignores tracking events and returns identical acknowledgements for unknown messages',async()=>{
  await seed();const a=await post('resend',resend('email.opened')),b=await post('resend',resend('email.delivered',{email_id:'unknown-message',tags:{}}));expect(await a.json()).toEqual(await b.json());expect(await events()).toHaveLength(0);
 });
 it('bounds body bytes, compression, event counts and malformed batches before any mutation',async()=>{
  await seed('sendgrid');const large='x'.repeat(128*1024+1);expect((await post('sendgrid',null,{raw:large})).status).toBe(413);
  const raw=JSON.stringify([sg()]),compressed=signed('sendgrid',raw);compressed.set('Content-Encoding','gzip');expect((await post('sendgrid',null,{raw,headers:compressed})).status).toBe(415);
  expect((await post('sendgrid',Array.from({length:101},()=>sg()))).status).toBe(413);expect((await post('sendgrid',[sg(),sg('delivered',{email:'invalid'})])).status).toBe(422);expect((await post('sendgrid',null,{raw:'{bad JSON'})).status).toBe(400);expect(await events()).toHaveLength(0);
 });
 it('processes the largest supported signed batch with unique event deduplication',async()=>{
  await seed('sendgrid',deliveryId,{first:new Date(Date.now()-600000).toISOString()});const batch=Array.from({length:100},(_,i)=>sg('deferred',{timestamp:Math.floor(Date.now()/1000)-100+i,sg_event_id:'bounded-event-'+i}));const r=await post('sendgrid',batch);expect(r.status,await r.clone().text()).toBe(200);expect(await events()).toHaveLength(100);expect((await status()).delivery_status).toBe('delayed');expect(providerCalls).toBe(0);
 });
 it('fails visibly rather than acknowledging a new receipt lost at the bounded ledger cap',async()=>{
  await seed();const now=at();await db.prepare(`INSERT INTO email_receipt_events(provider,event_id_hash,delivery_id,event_type,outcome,occurred_at,received_at,content_hash,ingestion_id) SELECT 'resend',value,?,'email.sent','accepted',?,?,'fixture-hash','cap-fixture' FROM json_each(?)`).bind(deliveryId,now,now,JSON.stringify(Array.from({length:512},(_,i)=>'capacity-'+i))).run();
  const response=await post('resend',resend());expect(response.status).toBe(503);expect((await status()).delivered_at).toBeNull();expect(await events()).toHaveLength(512);expect(providerCalls).toBe(0);
 });
});
describe('official cryptographic conformance fixtures',()=>{
 it('verifies the Svix published HMAC vector and rotation header',async()=>{
  const raw='{"event_type":"ping","data":{"success":true}}',headers=new Headers({'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v2,ignored v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='});
  const r=await mf.dispatchFetch('https://receipt.fixture.example/signature/resend?vector=1&now=1731705121000',{method:'POST',headers:Object.fromEntries(headers),body:raw});expect(r.status,await r.clone().text()).toBe(200);
 });
 it('verifies the SendGrid SDK published DER/SPKI vector including exact trailing CRLF',async()=>{
  const raw=JSON.stringify([{email:'hello@world.com',event:'dropped',reason:'Bounced Address',sg_event_id:'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',sg_message_id:'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0','smtp-id':'<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>',timestamp:1600112492}])+'\r\n';
  const headers=new Headers({'x-twilio-email-event-webhook-timestamp':'1600112502','x-twilio-email-event-webhook-signature':'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM='});
  const target='https://receipt.fixture.example/signature/sendgrid?vector=1&now=1600112502000';expect((await mf.dispatchFetch(target,{method:'POST',headers:Object.fromEntries(headers),body:raw})).status).toBe(200);expect((await mf.dispatchFetch(target,{method:'POST',headers:Object.fromEntries(headers),body:raw.trim()})).status).toBe(401);
 });
 it('rejects a malformed DER signature even when its timestamp is valid',async()=>{
  const raw=JSON.stringify([sg()]),headers=signed('sendgrid',raw,{signature:Buffer.from([0x30,6,2,1,0,2,1,0,0]).toString('base64')});expect((await post('sendgrid',null,{raw,headers})).status).toBe(401);
 });
});
