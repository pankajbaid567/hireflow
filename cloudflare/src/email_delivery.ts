/** Durable owner-only report delivery. Provider acceptance is not inbox delivery. */
import {ApiError,type Env,type Row,parsed} from './types';
import {all,first,run} from './storage';
import {files} from './files';
import {digest} from './auth';

const escape=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const leaseMs=120_000,retentionMs=30*86400_000,maxAttempts=3;
// Stop one hour before the provider's 24h key retention boundary, including clock skew.
const idempotencyWindow=23*3600_000;
const uncertain='The provider outcome is uncertain. Check the email provider dashboard before sending another report; automatic resend is disabled.';
const ownerChanged='Email delivery cancelled because the owner email or scheduled delivery consent changed.';
type Consent={schedule_run_id?:string;schedule_version?:number};
export function emailReadiness(env:Env){
 const provider=env.EMAIL_PROVIDER||'resend',configured=['resend','sendgrid'].includes(provider),key=provider==='resend'?env.RESEND_API_KEY:env.SENDGRID_API_KEY;
 const sender=String(env.FROM_EMAIL||'').trim(),validSender=/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(sender)&&!/(?:@example\.(?:com|org|net)|@localhost)$/i.test(sender);
 const ready=Boolean(configured&&key&&validSender);
 return{ready,provider:configured?provider:null,reason:ready?null:'Configure the selected email provider key and a verified FROM_EMAIL address. Provider/domain verification must be checked in its dashboard.',delivery_evidence:'Provider acceptance is recorded separately; a verified delivery event establishes recipient mail server acceptance, not inbox placement or reading.'};
}
function configuration(env:Env){const readiness=emailReadiness(env);if(!readiness.ready)throw new ApiError(503,readiness.reason!);return{provider:readiness.provider!,sender:String(env.FROM_EMAIL).trim()};}
export function deliveryMetadata(row:Row){return{id:row.id,report_id:row.report_id,status:row.state,state:row.state,delivery_status:row.delivery_status??null,delivery_status_at:row.delivery_status_at??null,receipt_received_at:row.receipt_received_at??null,delivery_evidence:row.delivery_status?'signed_provider_webhook':row.accepted_at?'provider_api_acceptance':'none',provider:row.provider,created_at:row.created_at,attempts:row.attempts,attachment_count:row.attachment_count,linked_count:row.linked_count,accepted_at:row.accepted_at,delivered_at:row.delivered_at,provider_message_id:row.provider_message_id,failure_reason:row.failure_reason,next_attempt_at:row.next_attempt_at,status_url:`/report/${row.user_id}/email-deliveries/${row.id}`};}
export async function emailDeliveryStatus(env:Env,owner:number,id:string){const row=await first(env,'SELECT * FROM email_deliveries WHERE id=? AND user_id=?',id,owner);if(!row)throw new ApiError(404,'Email delivery not found');return deliveryMetadata(row);}
async function dispatch(env:Env,row:Row){try{const delay=Math.max(0,Math.min(300,Math.ceil((Date.parse(row.next_attempt_at||'')-Date.now())/1000)||0));await env.APPLICATION_QUEUE.send({kind:'email_delivery',delivery_id:row.id},{delaySeconds:delay});await run(env,"UPDATE email_deliveries SET dispatched_at=? WHERE id=? AND state IN ('queued','ready','retry_wait')",new Date().toISOString(),row.id);}catch{/* The durable row is recovered by maintenance. */}}
async function consentValid(env:Env,row:Row,requireBinding=true){
 const current=await first(env,`SELECT u.email FROM users u WHERE u.id=? AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.user_id=u.id AND d.state IN ('queued','deleting'))`,row.user_id);
 if(!current||current.email!==row.recipient)return false;
 if(!row.schedule_run_id)return true;
 return Boolean(await first(env,`SELECT r.id FROM weekly_schedule_runs r JOIN weekly_schedules s ON s.user_id=r.user_id JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.user_id=? AND r.schedule_version=? AND s.version=? AND s.enabled=1 AND s.email_opt_in=1 AND r.state IN ('running','waiting','completed') AND u.profile_version=r.profile_version AND (?=0 OR r.email_delivery_id=?)`,row.schedule_run_id,row.user_id,row.schedule_version,row.schedule_version,Number(requireBinding),row.id??''));
}
async function bindScheduledDelivery(env:Env,owner:number,row:Row,consent:Consent){
 if(!consent.schedule_run_id)return row;
 await run(env,`UPDATE weekly_schedule_runs SET email_delivery_id=? WHERE id=? AND user_id=? AND schedule_version=? AND email_delivery_id IS NULL AND state IN ('running','waiting','completed') AND EXISTS(SELECT 1 FROM weekly_schedules s JOIN users u ON u.id=s.user_id WHERE s.user_id=weekly_schedule_runs.user_id AND s.enabled=1 AND s.email_opt_in=1 AND s.version=weekly_schedule_runs.schedule_version AND u.profile_version=weekly_schedule_runs.profile_version)`,row.id,consent.schedule_run_id,owner,consent.schedule_version??null);
 const bound=await first(env,'SELECT d.* FROM weekly_schedule_runs r JOIN email_deliveries d ON d.id=r.email_delivery_id AND d.user_id=r.user_id WHERE r.id=? AND r.user_id=?',consent.schedule_run_id,owner);
 if(!bound)throw new ApiError(409,ownerChanged);return bound;
}
export async function enqueueReportEmail(env:Env,owner:number,consent:Consent={}){
 // A scheduled event owns one delivery even if its stage is replayed after the
 // weekly report was regenerated. Keep the original payload and idempotency key.
 if(consent.schedule_run_id){const existing=await first(env,'SELECT d.* FROM weekly_schedule_runs r JOIN email_deliveries d ON d.id=r.email_delivery_id AND d.user_id=r.user_id WHERE r.id=? AND r.user_id=?',consent.schedule_run_id,owner)||await first(env,'SELECT * FROM email_deliveries WHERE user_id=? AND schedule_run_id=?',owner,consent.schedule_run_id);if(existing){const bound=await bindScheduledDelivery(env,owner,existing,consent);if(['queued','ready','retry_wait'].includes(bound.state)&&!bound.dispatched_at&&await consentValid(env,bound))await dispatch(env,bound);return deliveryMetadata(bound);}}
 const config=configuration(env),snapshot=await env.DB.batch([
  env.DB.prepare('SELECT id,email FROM users WHERE id=?').bind(owner),
  env.DB.prepare('SELECT * FROM weekly_reports WHERE user_id=? ORDER BY week_start_date DESC,id DESC LIMIT 1').bind(owner),
 ]),user=snapshot[0].results[0] as Row|undefined,report=snapshot[1].results[0] as Row|undefined;
 if(!user)throw new ApiError(404,'Profile not found');if(!report)throw new ApiError(404,'No weekly report generated yet');
 let row=await first(env,'SELECT * FROM email_deliveries WHERE user_id=? AND report_key=? AND provider=? AND recipient=?',owner,report.html_path,config.provider,user.email);
 if(row){row=await bindScheduledDelivery(env,owner,row,consent);if(['queued','ready','retry_wait'].includes(row.state)&&!row.dispatched_at&&await consentValid(env,row))await dispatch(env,row);return deliveryMetadata(row);}
 const content=parsed<Row>(report.content,{}),apps=Array.isArray(content.applications)?content.applications.slice(0,100):[],ids=apps.map((a:Row)=>Number(a.id)).filter(Number.isSafeInteger);
 const sources:Row[]=[];
 if(ids.length){
  const resumes=await all(env,'SELECT r.application_id,r.version,r.object_key,a.resume_version FROM resumes r JOIN applications a ON a.id=r.application_id WHERE a.user_id=? AND a.id IN (SELECT value FROM json_each(?)) ORDER BY r.version DESC',owner,JSON.stringify(ids));
  for(const app of apps){const resume=resumes.find(r=>r.application_id===app.id&&r.version===(app.resume_version??r.resume_version));if(!resume){if(app.resume_url)throw new ApiError(409,'A resume version selected by this report is no longer available. Regenerate the report before requesting delivery.');continue;}sources.push({kind:'resume',key:resume.object_key,filename:`${app.id}_resume_v${resume.version}.pdf`,url:`/resumes/${owner}/${app.id}/download?version=${resume.version}`});}
  const exports=apps.filter((a:Row)=>a.prep_export?.id).map((a:Row)=>a.prep_export.id);
  if(exports.length){const ready=await all(env,`SELECT e.* FROM prep_guide_exports e JOIN applications a ON a.id=e.application_id AND a.user_id=e.user_id WHERE e.user_id=? AND e.id IN (SELECT value FROM json_each(?)) AND e.state='ready' AND e.expires_at>?`,owner,JSON.stringify(exports),new Date().toISOString());for(const item of ready)sources.push({kind:'prep',key:item.pdf_key,filename:`${item.application_id}_prep_guide_v${item.version}.pdf`,url:`/applications/${item.application_id}/prep-guide/exports/${item.id}/pdf`});}
 }
 const id=crypto.randomUUID(),now=new Date().toISOString(),payloadKey=`mail/${owner}/${id}/payload.json`,keys=[report.html_path,...sources.map(s=>s.key)],input={sources,base:String(env.PUBLIC_BASE_URL||'').replace(/\/$/, '')};
 const candidate={user_id:owner,recipient:user.email,schedule_run_id:consent.schedule_run_id??null,schedule_version:consent.schedule_version??null};
 if(!await consentValid(env,candidate,false))throw new ApiError(409,ownerChanged);
 // One explicit immutable report version may be requested once per recipient/provider.
 row=await first(env,`INSERT INTO email_deliveries(id,user_id,report_id,report_key,provider,recipient,sender,subject,payload_key,source_artifacts,source_snapshot,idempotency_key,schedule_run_id,schedule_version,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND email=?) AND EXISTS(SELECT 1 FROM weekly_reports WHERE id=? AND user_id=? AND html_path=?) ON CONFLICT DO NOTHING RETURNING *`,id,owner,report.id,report.html_path,config.provider,user.email,config.sender,`HireFlow — week of ${report.week_start_date}`,payloadKey,JSON.stringify(keys),JSON.stringify(input),`hireflow-weekly/${id}`,candidate.schedule_run_id,candidate.schedule_version,now,new Date(Date.now()+retentionMs).toISOString(),owner,user.email,report.id,owner,report.html_path);
 if(!row&&consent.schedule_run_id)row=await first(env,'SELECT * FROM email_deliveries WHERE user_id=? AND schedule_run_id=?',owner,consent.schedule_run_id);
 if(!row)row=await first(env,'SELECT * FROM email_deliveries WHERE user_id=? AND report_key=? AND provider=? AND recipient=?',owner,report.html_path,config.provider,user.email);
 if(!row)throw new ApiError(409,'The report changed. Refresh it before requesting delivery.');row=await bindScheduledDelivery(env,owner,row,consent);if(await consentValid(env,row))await dispatch(env,row);return deliveryMetadata(row);
}
function base64(bytes:Uint8Array){let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary);}
async function buildPayload(env:Env,row:Row){
 const report=await files(env).get(row.report_key);if(!report)throw new Error('missing');if(report.size>250000)throw new Error('oversized');
 const snapshot=parsed<Row>(row.source_snapshot,{}),attachments:Row[]=[],links:string[]=[];let bytes=0;
 for(const source of snapshot.sources||[]){const file=await files(env).get(source.key);if(!file)throw new Error('missing');if(bytes+file.size>128*1024||attachments.length>=10){links.push(`<li><a href="${escape(snapshot.base+source.url)}">${escape(source.filename)}</a> (sign in to download)</li>`);continue;}bytes+=file.size;attachments.push({filename:source.filename,content:base64(new Uint8Array(await file.arrayBuffer())),type:'application/pdf',disposition:'attachment'});}
 // A random delivery UUID is sufficient for webhook correlation. Never place
 // candidate details or profile IDs in provider tags/custom arguments.
 const html=await report.text()+(links.length?`<p>Additional versioned PDFs are available in your private workspace:</p><ul>${links.join('')}</ul>`:''),payload=row.provider==='resend'?{from:row.sender,to:[row.recipient],subject:row.subject,html,attachments:attachments.map(a=>({filename:a.filename,content:a.content})),tags:[{name:'hireflow_delivery_id',value:row.id}]}:{personalizations:[{to:[{email:row.recipient}]}],from:{email:row.sender},subject:row.subject,content:[{type:'text/html',value:html}],attachments,custom_args:{hireflow_delivery_id:row.id}};
 const serialized=JSON.stringify(payload),hash=await digest(serialized);if(new TextEncoder().encode(serialized).byteLength>512000)throw new Error('oversized');
 await files(env).put(row.payload_key,serialized,{httpMetadata:{contentType:'application/json'}});
 return{hash,attachmentCount:attachments.length,linkedCount:links.length};
}
async function finish(env:Env,row:Row,state:string,reason:string|null,status:number|null=null){await env.DB.batch([
 env.DB.prepare('UPDATE weekly_reports SET email_failure_reason=? WHERE id=? AND user_id=? AND html_path=? AND EXISTS(SELECT 1 FROM email_deliveries WHERE id=? AND lease_token=? AND state=?)').bind(reason,row.report_id,row.user_id,row.report_key,row.id,row.lease_token,row.state),
 env.DB.prepare('UPDATE email_deliveries SET state=?,failure_reason=?,provider_status=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=? AND state=?').bind(state,reason,status,new Date().toISOString(),row.id,row.lease_token,row.state),
]);}
async function retry(env:Env,row:Row,reason:string,status:number|null=null){
 if(row.attempts>=maxAttempts||Date.now()-Date.parse(row.first_attempt_at)>=idempotencyWindow){await finish(env,row,'needs_action',uncertain,status);return;}
 const next=new Date(Date.now()+60_000*2**Math.max(0,row.attempts-1)).toISOString();
 const saved=await first(env,"UPDATE email_deliveries SET state='retry_wait',failure_reason=?,provider_status=?,next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE id=? AND lease_token=? RETURNING *",reason,status,next,row.id,row.lease_token);if(saved)await dispatch(env,saved);
}
export async function processEmailDelivery(env:Env,id:string){
 const token=crypto.randomUUID(),now=new Date().toISOString();
 let row=await first(env,`UPDATE email_deliveries SET state=CASE WHEN payload_hash IS NULL THEN 'preparing' ELSE 'ready' END,lease_token=?,lease_expires_at=? WHERE id=? AND state IN ('queued','ready','retry_wait') AND (lease_token IS NULL OR lease_expires_at<=?) AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND expires_at>? RETURNING *`,token,new Date(Date.now()+leaseMs).toISOString(),id,now,now,now);
 if(!row)return;
 try{
  if(!await consentValid(env,row)){
   const runBinding=row.schedule_run_id?await first(env,'SELECT email_delivery_id FROM weekly_schedule_runs WHERE id=? AND user_id=?',row.schedule_run_id,row.user_id):null;
   if(runBinding&&!runBinding.email_delivery_id&&await consentValid(env,row,false)){await run(env,"UPDATE email_deliveries SET state=CASE WHEN payload_hash IS NULL THEN 'queued' ELSE 'ready' END,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE id=? AND lease_token=?",row.id,row.lease_token);return;}
   await finish(env,row,'cancelled',ownerChanged);return;
  }
  const config=configuration(env);if(config.provider!==row.provider||config.sender!==row.sender){await finish(env,row,'failed','Email provider or sender configuration changed. Generate a new report before requesting delivery.');return;}
  if(!row.payload_hash){const built=await buildPayload(env,row);const saved=await first(env,"UPDATE email_deliveries SET state='ready',payload_hash=?,attachment_count=?,linked_count=? WHERE id=? AND state='preparing' AND lease_token=? AND lease_expires_at>? RETURNING *",built.hash,built.attachmentCount,built.linkedCount,id,token,new Date().toISOString());if(!saved)return;row=saved;}
  const file=await files(env).get(row.payload_key);if(!file)throw new Error('missing');const body=await file.text();if(await digest(body)!==row.payload_hash){await finish(env,row,'failed','The stored email payload failed its integrity check. No message was sent.');return;}
  if(row.first_attempt_at&&Date.now()-Date.parse(row.first_attempt_at)>=idempotencyWindow){await finish(env,row,'needs_action',uncertain);return;}
  // Check consent after every await that prepares/reads the immutable payload.
  if(!await consentValid(env,row)){await finish(env,row,'cancelled',ownerChanged);return;}
  const claimed=await first(env,`UPDATE email_deliveries SET state='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,?),next_attempt_at=NULL
   WHERE id=? AND state='ready' AND lease_token=? AND lease_expires_at>? AND attempts<?
   AND EXISTS(SELECT 1 FROM users u WHERE u.id=email_deliveries.user_id AND u.email=email_deliveries.recipient)
   AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.user_id=email_deliveries.user_id AND d.state IN ('queued','deleting'))
   AND (schedule_run_id IS NULL OR EXISTS(SELECT 1 FROM weekly_schedule_runs r JOIN weekly_schedules s ON s.user_id=r.user_id JOIN users u ON u.id=r.user_id WHERE r.id=email_deliveries.schedule_run_id AND r.user_id=email_deliveries.user_id AND r.schedule_version=email_deliveries.schedule_version AND r.email_delivery_id=email_deliveries.id AND s.version=email_deliveries.schedule_version AND s.enabled=1 AND s.email_opt_in=1 AND r.state IN ('running','waiting','completed') AND u.profile_version=r.profile_version)) RETURNING *`,new Date().toISOString(),id,token,new Date().toISOString(),maxAttempts);
  if(!claimed){await finish(env,row,'cancelled',ownerChanged);return;}row=claimed;
  let response:Response;
  try{response=await fetch(row.provider==='resend'?'https://api.resend.com/emails':'https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:`Bearer ${row.provider==='resend'?env.RESEND_API_KEY:env.SENDGRID_API_KEY}`,'Content-Type':'application/json',...(row.provider==='resend'?{'Idempotency-Key':row.idempotency_key}:{})},body,signal:AbortSignal.timeout(20_000)});}catch{if(row.provider==='resend')await retry(env,row,'The provider outcome is uncertain. Retrying this exact payload with the same idempotency key.');else await finish(env,row,'needs_action',uncertain);return;}
  if(!response.ok){const status=response.status;await response.body?.cancel();if(row.provider==='resend'&&(status===429||status>=500||status===409)){await retry(env,row,'Email provider temporarily unavailable. Only the original immutable payload will be retried.',status);return;}await finish(env,row,status>=500?'needs_action':'failed',status>=500?uncertain:'The email provider rejected the message. Check the verified sender and provider account configuration.',status);return;}
  let providerId:string|null=null;if(row.provider==='resend'){try{const data=await response.json() as Row;if(typeof data.id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(data.id))providerId=data.id;}catch{/* Accepted HTTP response remains distinct from delivery receipt. */}}else{const value=response.headers.get('x-message-id');if(value&&/^[a-zA-Z0-9_.-]{1,200}$/.test(value))providerId=value;await response.body?.cancel();}
  const accepted=new Date().toISOString();await env.DB.batch([
   env.DB.prepare("UPDATE weekly_reports SET email_sent_at=?,email_failure_reason=NULL WHERE id=? AND user_id=? AND html_path=? AND EXISTS(SELECT 1 FROM email_deliveries WHERE id=? AND state='sending' AND lease_token=?)").bind(accepted,row.report_id,row.user_id,row.report_key,id,token),
   env.DB.prepare("UPDATE email_deliveries SET state='accepted',accepted_at=?,finished_at=?,provider_message_id=?,provider_status=?,failure_reason=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND state='sending' AND lease_token=?").bind(accepted,accepted,providerId,response.status,id,token),
  ]);
 }catch{if(row)await finish(env,row,row.state==='sending'?'needs_action':'failed',row.state==='sending'?uncertain:'The email payload could not be prepared safely. Check the report files and provider setup; no new message was sent.');}
}
export async function recoverEmailDeliveries(env:Env){
 const now=new Date().toISOString(),safeBefore=new Date(Date.now()-idempotencyWindow).toISOString();
 await run(env,"UPDATE email_deliveries SET state='needs_action',failure_reason=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE state='sending' AND lease_expires_at<=? AND (provider='sendgrid' OR first_attempt_at<=? OR attempts>=?)",uncertain,now,now,safeBefore,maxAttempts);
 await run(env,"UPDATE email_deliveries SET state='retry_wait',failure_reason='Interrupted provider request. Retrying the identical payload with its original idempotency key.',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE state='sending' AND provider='resend' AND lease_expires_at<=? AND first_attempt_at>? AND attempts<?",now,now,safeBefore,maxAttempts);
 await run(env,"UPDATE email_deliveries SET state=CASE WHEN payload_hash IS NULL THEN 'queued' ELSE 'ready' END,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE state IN ('preparing','ready') AND lease_expires_at<=?",now);
 await run(env,"UPDATE email_deliveries SET state='failed',failure_reason='Email delivery request expired. Generate a fresh report before requesting delivery.',finished_at=? WHERE state IN ('queued','preparing','ready','retry_wait') AND expires_at<=?",now,now);
 const pending=await all(env,"SELECT * FROM email_deliveries WHERE state IN ('queued','ready','retry_wait') AND lease_token IS NULL AND (dispatched_at IS NULL OR dispatched_at<?) AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND expires_at>? ORDER BY created_at LIMIT 3",new Date(Date.now()-300_000).toISOString(),now,now);for(const row of pending)await dispatch(env,row);
}
