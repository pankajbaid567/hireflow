/** Signed delivery evidence. Provider server acceptance is not a read receipt. */
import {ApiError, type Env, type Row, json} from './types';
import {all} from './storage';
import {digest} from './auth';

type Provider='resend'|'sendgrid';
type Outcome='accepted'|'delayed'|'delivered'|'bounced'|'failed'|'complained';
type WebhookEnv=Env & {RESEND_WEBHOOK_SECRET?:string;SENDGRID_WEBHOOK_PUBLIC_KEY?:string};
type Receipt={id:string;type:string;outcome:Outcome;at:string;message:string|null;correlation:string|null;recipient:string};
const encoder=new TextEncoder(),maxBody=128*1024,maxEvents=100,toleranceMs=300000;
// When a provider reports only whole seconds, surface a failure/complaint on
// an ambiguous tie while preserving any independently verified delivered_at.
const rank:Record<Outcome,number>={accepted:1,delayed:2,delivered:3,failed:4,bounced:5,complained:6};
const resendOutcomes:Record<string,Outcome>={'email.sent':'accepted','email.delivery_delayed':'delayed','email.delivered':'delivered','email.bounced':'bounced','email.failed':'failed','email.suppressed':'failed','email.complained':'complained'};
const sendgridOutcomes:Record<string,Outcome>={processed:'accepted',deferred:'delayed',delivered:'delivered',bounce:'bounced',dropped:'failed',spamreport:'complained'};
const reasons:Record<Outcome,string|null>={accepted:null,delivered:null,delayed:'The email provider reported a temporary delivery delay. Do not send a duplicate report.',bounced:'The recipient mail server rejected this email. Check the address before requesting another report.',failed:'The email provider reported a delivery failure. Check the verified sender and provider account before requesting another report.',complained:'The recipient marked this email as spam. Check delivery consent before sending again.'};
const object=(value:unknown):Row=>value&&typeof value==='object'&&!Array.isArray(value)?value as Row:{};
const identifier=(value:unknown,maximum=512):string|null=>typeof value==='string'&&value.length>0&&value.length<=maximum&&/^[A-Za-z0-9_.+/=:-]+$/.test(value)?value:null;
const uuid=(value:unknown):string|null=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)?value:null;
function bytes(value:string){
 if(!/^[A-Za-z0-9+/]*={0,2}$/.test(value)||value.length%4===1)throw new Error('invalid base64');
 return Uint8Array.from(atob(value),c=>c.charCodeAt(0));
}
function joined(prefix:string,body:Uint8Array){const first=encoder.encode(prefix),result=new Uint8Array(first.length+body.length);result.set(first);result.set(body,first.length);return result;}
function timestamp(raw:string|null,now:number){if(!raw||!/^\d{1,12}$/.test(raw)||Math.abs(Number(raw)*1000-now)>toleranceMs)throw new ApiError(401,'Invalid email webhook signature or timestamp.');return raw;}
/** DER ECDSA integers converted to WebCrypto's fixed-width IEEE P1363 format. */
function ecdsaSignature(der:Uint8Array){
 if(der.length<8||der.length>72||der[0]!==0x30||der[1]!==der.length-2)throw new Error('invalid DER');
 const out=new Uint8Array(64);let cursor=2;
 for(let part=0;part<2;part++){
  if(der[cursor++]!==2)throw new Error('invalid DER integer');const length=der[cursor++];
  if(length<1||length>33||cursor+length>der.length||der[cursor]&0x80)throw new Error('invalid DER integer');
  let integer=der.subarray(cursor,cursor+length);cursor+=length;
  if(integer[0]===0&&integer.length>1){if(!(integer[1]&0x80))throw new Error('nonminimal DER integer');integer=integer.subarray(1);}
  if(integer.length>32)throw new Error('oversized DER integer');out.set(integer,part*32+32-integer.length);
 }
 if(cursor!==der.length)throw new Error('trailing DER');return out;
}
/** Exposed for conformance tests; HTTP callers cannot choose the clock. */
export async function verifyEmailSignature(provider:Provider,body:Uint8Array,headers:Headers,env:WebhookEnv,now=Date.now()):Promise<void>{
 if(provider==='resend'&&!env.RESEND_WEBHOOK_SECRET||provider==='sendgrid'&&!env.SENDGRID_WEBHOOK_PUBLIC_KEY)throw new ApiError(503,'Signed email receipt verification is not configured.');
 try{
  if(provider==='resend'){
   const time=timestamp(headers.get('svix-timestamp'),now),id=identifier(headers.get('svix-id'),128),signatures=headers.get('svix-signature')||'',secret=env.RESEND_WEBHOOK_SECRET!;
   if(!id||signatures.length>1024||!secret.startsWith('whsec_'))throw new Error('invalid Svix headers');
   const keyBytes=bytes(secret.slice(6));if(keyBytes.length<16||keyBytes.length>64)throw new Error('invalid signing key');
   const key=await crypto.subtle.importKey('raw',keyBytes,{name:'HMAC',hash:'SHA-256'},false,['verify']),signed=joined(`${id}.${time}.`,body);
   // Svix can include multiple v1 signatures while rotating its signing secret.
   for(const candidate of signatures.split(/\s+/).slice(0,10)){
    if(!candidate.startsWith('v1,'))continue;
    try{const signature=bytes(candidate.slice(3));if(signature.length===32&&await crypto.subtle.verify('HMAC',key,signature,signed))return;}catch{/* Try only another signed v1 candidate. */}
   }
  }else{
   const time=timestamp(headers.get('x-twilio-email-event-webhook-timestamp'),now),signature=headers.get('x-twilio-email-event-webhook-signature')||'';
   if(signature.length>160)throw new Error('invalid signature');
   const publicKey=env.SENDGRID_WEBHOOK_PUBLIC_KEY!.trim().replace(/^-----BEGIN PUBLIC KEY-----\s*/,'').replace(/\s*-----END PUBLIC KEY-----$/,'').replace(/\s/g,'');
   const key=await crypto.subtle.importKey('spki',bytes(publicKey),{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
   if(await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,ecdsaSignature(bytes(signature)),joined(time,body)))return;
  }
 }catch(error){if(error instanceof ApiError)throw error;}
 throw new ApiError(401,'Invalid email webhook signature or timestamp.');
}
async function rawBody(request:Request){
 const length=request.headers.get('content-length');
 if(length&&(!/^\d+$/.test(length)||Number(length)>maxBody))throw new ApiError(413,'Email webhook payload exceeds the supported size.');
 if(request.headers.get('content-encoding')&&!/^identity$/i.test(request.headers.get('content-encoding')!))throw new ApiError(415,'Compressed email webhook bodies are not supported.');
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')||''))throw new ApiError(415,'Email webhooks require application/json.');
 const reader=request.body?.getReader();if(!reader)throw new ApiError(400,'Missing email webhook payload.');
 const pieces:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  return await Promise.race([async function(){for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBody)throw new ApiError(413,'Email webhook payload exceeds the supported size.');pieces.push(value);}const result=new Uint8Array(size);let offset=0;for(const piece of pieces){result.set(piece,offset);offset+=piece.length;}return result;}(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new ApiError(408,'Email webhook body timed out.')),5000);})]);
 }finally{clearTimeout(timer);await reader.cancel().catch(()=>{});}
}
function normalize(provider:Provider,payload:unknown,id:string|null,now:number):Receipt[]{
 const source=provider==='resend'?[payload]:payload;if(!Array.isArray(source)||source.length>maxEvents)throw new ApiError(413,'An email webhook can contain at most 100 events.');
 const receipts:Receipt[]=[];
 for(const value of source){
  const event=object(value),type=provider==='resend'?event.type:event.event,map=provider==='resend'?resendOutcomes:sendgridOutcomes;
  if(typeof type!=='string'||!Object.hasOwn(map,type))continue; // Opens/clicks are not delivery proof and are never retained.
  const data=provider==='resend'?object(event.data):event,outcome=map[type],eventId=provider==='resend'?id:identifier(event.sg_event_id),message=identifier(provider==='resend'?data.email_id:event.sg_message_id),correlation=uuid(provider==='resend'?object(data.tags).hireflow_delivery_id:event.hireflow_delivery_id);
  const to=provider==='resend'?data.to:[event.email],at=provider==='resend'?Date.parse(event.created_at):typeof event.timestamp==='number'||typeof event.timestamp==='string'?Number(event.timestamp)*1000:NaN;
  if(!eventId||(!message&&!correlation)||!Array.isArray(to)||to.length!==1||typeof to[0]!=='string'||to[0].length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(to[0])||!Number.isFinite(at)||at<0||at>now+toleranceMs)throw new ApiError(422,'Invalid delivery receipt fields.');
  receipts.push({id:eventId,type,outcome,at:new Date(at).toISOString(),message,correlation,recipient:to[0].toLowerCase()});
 }
 return receipts.sort((a,b)=>a.at.localeCompare(b.at)||rank[a.outcome]-rank[b.outcome]);
}
function newer(outcome:Outcome){
 // Transient statuses cannot erase a terminal result even if re-delivered later.
 const allowed=outcome==='accepted'?"delivery_status='accepted'":outcome==='delayed'?"delivery_status IN ('accepted','delayed')":"delivery_status<>'complained'";
 const oldRank="CASE delivery_status WHEN 'accepted' THEN 1 WHEN 'delayed' THEN 2 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 4 WHEN 'bounced' THEN 5 WHEN 'complained' THEN 6 ELSE 0 END";
 return `(delivery_status IS NULL OR ((${allowed}) AND (delivery_status_at<? OR (delivery_status_at=? AND ${oldRank}<=${rank[outcome]}))))`;
}
export async function receiveEmailWebhook(request:Request,env:WebhookEnv,provider:Provider):Promise<Response>{
 if(request.method!=='POST')throw new ApiError(405,'Email webhooks require POST.');
 // Fail closed before body parsing, database queries or any provider request.
 if(provider==='resend'&&!env.RESEND_WEBHOOK_SECRET||provider==='sendgrid'&&!env.SENDGRID_WEBHOOK_PUBLIC_KEY)throw new ApiError(503,'Signed email receipt verification is not configured.');
 const body=await rawBody(request);await verifyEmailSignature(provider,body,request.headers,env);let payload:unknown;
 try{payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{throw new ApiError(400,'Invalid email webhook JSON.');}
 const receipts=normalize(provider,payload,identifier(request.headers.get('svix-id'),128),Date.now());if(!receipts.length)return json({received:true});
 const candidates=await all(env,`SELECT * FROM email_deliveries WHERE provider=? AND first_attempt_at IS NOT NULL AND attempts>0 AND (id IN (SELECT value FROM json_each(?)) OR provider_message_id IN (SELECT value FROM json_each(?)) OR receipt_provider_message_id IN (SELECT value FROM json_each(?))) LIMIT 101`,provider,JSON.stringify(receipts.map(r=>r.correlation).filter(Boolean)),JSON.stringify(receipts.map(r=>r.message).filter(Boolean)),JSON.stringify(receipts.map(r=>r.message).filter(Boolean)));
 const matched=receipts.flatMap(receipt=>{
  const rows=candidates.filter(row=>row.recipient.toLowerCase()===receipt.recipient&&(receipt.correlation?row.id===receipt.correlation:row.provider_message_id===receipt.message||row.receipt_provider_message_id===receipt.message)&&Date.parse(receipt.at)>=Date.parse(row.first_attempt_at)-60000);
  if(rows.length!==1)return[];const row=rows[0];
  if(provider==='resend'&&row.provider_message_id&&row.provider_message_id!==receipt.message||row.receipt_provider_message_id&&receipt.message&&row.receipt_provider_message_id!==receipt.message)return[];
  return[{receipt,row}];
 });
 if(!matched.length)return json({received:true}); // No recipient, ID, or ownership information is disclosed.
 const hashes=await Promise.all(matched.map(async value=>({...value,eventHash:await digest(provider+'\0'+value.receipt.id),contentHash:await digest(JSON.stringify(value.receipt))})));
 const inRequest=new Map<string,string>();
 for(const value of hashes){const previous=inRequest.get(value.eventHash);if(previous&&previous!==value.contentHash)throw new ApiError(409,'An email receipt identifier was reused with different content.');inRequest.set(value.eventHash,value.contentHash);}
 const hashed=[...new Map(hashes.map(value=>[value.eventHash,value])).values()];
 const existing=await all(env,'SELECT event_id_hash,content_hash FROM email_receipt_events WHERE provider=? AND event_id_hash IN (SELECT value FROM json_each(?))',provider,JSON.stringify(hashed.map(v=>v.eventHash)));
 if(hashed.some(value=>existing.some(row=>row.event_id_hash===value.eventHash&&row.content_hash!==value.contentHash)))throw new ApiError(409,'An email receipt identifier was reused with different content.');
 const ingestion=crypto.randomUUID(),received=new Date().toISOString(),statements:D1PreparedStatement[]=[],insertIndexes:number[]=[];
 for(const{receipt:r,row,eventHash,contentHash}of hashed){
  insertIndexes.push(statements.length);
  statements.push(env.DB.prepare(`INSERT INTO email_receipt_events(provider,event_id_hash,delivery_id,event_type,outcome,occurred_at,received_at,content_hash,ingestion_id) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM email_deliveries WHERE id=? AND provider=? AND recipient=? AND first_attempt_at IS NOT NULL AND attempts>0) AND (SELECT count(*) FROM email_receipt_events WHERE delivery_id=?)<512 ON CONFLICT DO NOTHING`).bind(provider,eventHash,row.id,r.type,r.outcome,r.at,received,contentHash,ingestion,row.id,provider,row.recipient,row.id));
  const guard="EXISTS(SELECT 1 FROM email_receipt_events WHERE provider=? AND event_id_hash=? AND delivery_id=email_deliveries.id AND content_hash=? AND ingestion_id=?)";
  // A signed sent/processed event can beat the provider HTTP response. Record
  // that acceptance even if a newer terminal receipt already won; never infer
  // its timestamp from delivered/bounced evidence or replace an API timestamp.
  if(r.outcome==='accepted')statements.push(env.DB.prepare(`UPDATE email_deliveries SET accepted_at=COALESCE(accepted_at,?) WHERE id=? AND ${guard}`).bind(r.at,row.id,provider,eventHash,contentHash,ingestion));
  statements.push(env.DB.prepare(`UPDATE email_deliveries SET delivery_status=?,delivery_status_at=?,receipt_received_at=?,receipt_provider_message_id=COALESCE(receipt_provider_message_id,?),failure_reason=?,state=CASE WHEN state IN ('queued','preparing','ready','sending','retry_wait','needs_action') THEN 'accepted' ELSE state END,lease_token=NULL,lease_expires_at=NULL,finished_at=COALESCE(finished_at,?) WHERE id=? AND ${guard} AND ${newer(r.outcome)}`).bind(r.outcome,r.at,received,r.message,reasons[r.outcome],received,row.id,provider,eventHash,contentHash,ingestion,r.at,r.at));
  if(r.outcome==='delivered')statements.push(env.DB.prepare(`UPDATE email_deliveries SET delivered_at=CASE WHEN delivered_at IS NULL OR delivered_at>? THEN ? ELSE delivered_at END WHERE id=? AND ${guard}`).bind(r.at,r.at,row.id,provider,eventHash,contentHash,ingestion));
  statements.push(env.DB.prepare(`UPDATE weekly_reports SET email_failure_reason=(SELECT failure_reason FROM email_deliveries WHERE id=?),email_sent_at=CASE WHEN ?='accepted' THEN COALESCE(email_sent_at,(SELECT accepted_at FROM email_deliveries WHERE id=?)) ELSE email_sent_at END WHERE id=? AND user_id=? AND html_path=? AND EXISTS(SELECT 1 FROM email_receipt_events WHERE provider=? AND event_id_hash=? AND content_hash=? AND ingestion_id=?)`).bind(row.id,r.outcome,row.id,row.report_id,row.user_id,row.report_key,provider,eventHash,contentHash,ingestion));
 }
 // One transactional batch keeps a verified event, its outcome and report in sync.
 const results=await env.DB.batch(statements);
 // Do not acknowledge a new event silently if a concurrent update or the
 // per-delivery retention cap prevented capture. Retrying is idempotent.
 const uncaptured=hashed.filter((value,index)=>!existing.some(row=>row.event_id_hash===value.eventHash)&&Number(results[insertIndexes[index]].meta.changes)===0);
 if(uncaptured.length){
  const concurrent=await all(env,'SELECT event_id_hash,content_hash FROM email_receipt_events WHERE provider=? AND event_id_hash IN (SELECT value FROM json_each(?))',provider,JSON.stringify(uncaptured.map(value=>value.eventHash)));
  if(uncaptured.some(value=>!concurrent.some(row=>row.event_id_hash===value.eventHash&&row.content_hash===value.contentHash)))throw new ApiError(503,'The delivery receipt could not be captured. Retry this provider notification; do not resend the email.');
 }
 return json({received:true});
}
