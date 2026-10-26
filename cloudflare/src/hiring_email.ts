/** Explicit, snapshot-bound hiring report delivery; SMTP has no resend guarantee. */
import {ApiError,type Env,type Row,parsed} from './types';
import {first,all,run} from './storage';
import {digest} from './auth';
import {emailReadiness} from './email_delivery';
import {sendGmailMessage,gmailRecipientAllowed} from './gmail_transport';

const uncertain='Gmail acceptance is uncertain. Check the sender Sent folder and recipient before taking any action. Automatic resend is disabled.';
const email=(value:unknown)=>typeof value==='string'&&value.length<=254&&/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)?value.toLowerCase():null;
const allowed=(env:Env,recipient:string)=>gmailRecipientAllowed(env,recipient);
export function hiringEmailReadiness(env:Env){const setup=emailReadiness(env),ready=setup.ready&&setup.provider==='gmail';return{ready,provider:'gmail',reason:ready?null:'Configure EMAIL_PROVIDER=gmail, GMAIL_USER and its App Password. Additional team recipients must be explicitly authorized in the private Gmail recipient allowlist.',recipient_policy:'The configured sender account or a privately authorized recipient only. The full recipient list is never exposed.',delivery_evidence:'SMTP acceptance is not proof of recipient inbox placement or reading.'};}
const metadata=(row:Row)=>({id:row.id,shortlist_id:row.shortlist_id,state:row.state,provider:'gmail',recipient:row.recipient,report_hash:row.report_hash,attempts:row.attempts,created_at:row.created_at,started_at:row.started_at,accepted_at:row.accepted_at,failure_reason:row.failure_reason,status_url:`/hiring/email-deliveries/${row.id}`,delivery_evidence:row.accepted_at?'smtp_server_acceptance':'none'});
async function dispatch(env:Env,row:Row){try{await env.APPLICATION_QUEUE.send({kind:'hiring_email',delivery_id:row.id});await run(env,"UPDATE hiring_email_deliveries SET dispatched_at=? WHERE id=? AND state='queued'",new Date().toISOString(),row.id);}catch{/* Queued immutable rows are recovered by maintenance. */}}
export async function enqueueHiringEmail(env:Env,owner:number,shortlistId:number,data:Row){
 const report=await first(env,'SELECT * FROM shortlists WHERE id=? AND user_id=?',shortlistId,owner);if(!report)throw new ApiError(404,'Hiring report not found');
 if(report.state!=='completed'||!report.report_hash||!report.report_html)throw new ApiError(409,'Prepare a current evidence report before requesting email.');
 if(new TextEncoder().encode(report.report_html).length>250000)throw new ApiError(413,'This hiring report is too large for Gmail delivery. Download the private report or create a smaller batch.');
 if(data.reviewed!==true||data.report_hash!==report.report_hash)throw new ApiError(409,'Review this exact hiring report before authorizing its delivery.');
 const recipient=email(data.recipient);if(!recipient||data.confirm_recipient!==data.recipient)throw new ApiError(422,'Enter and confirm one exact recipient email.');
 if(!hiringEmailReadiness(env).ready)throw new ApiError(503,hiringEmailReadiness(env).reason!);
 if(!allowed(env,recipient))throw new ApiError(403,'That team recipient is not authorized by this deployment. Ask the operator to configure the private Gmail recipient allowlist.');
 const prior=await first(env,'SELECT * FROM hiring_email_deliveries WHERE shortlist_id=? AND user_id=? AND recipient=? AND report_hash=?',shortlistId,owner,recipient,report.report_hash);if(prior){if(prior.state==='queued'&&!prior.dispatched_at)await dispatch(env,prior);return metadata(prior);}
 const id=crypto.randomUUID(),sender=String(env.GMAIL_USER).trim().toLowerCase(),messageId=`<${id}@hireflow.invalid>`,subject='HireFlow hiring shortlist for human review',payload={from:sender,to:recipient,subject,html:report.report_html,messageId,date:new Date().toISOString()},serialized=JSON.stringify(payload);
 if(new TextEncoder().encode(serialized).length>900000)throw new ApiError(413,'The hiring email exceeds its bounded payload size. Use a smaller applicant pool.');
 const now=new Date().toISOString(),saved=await first(env,`INSERT INTO hiring_email_deliveries(id,user_id,shortlist_id,recipient,sender,report_hash,payload,payload_hash,message_id,created_at,expires_at)
 SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM shortlists WHERE id=? AND user_id=? AND report_hash=? AND state='completed') AND NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=? AND state IN ('queued','deleting')) ON CONFLICT DO NOTHING RETURNING *`,id,owner,shortlistId,recipient,sender,report.report_hash,serialized,await digest(serialized),messageId,now,new Date(Date.now()+86400000).toISOString(),shortlistId,owner,report.report_hash,owner);
 const row=saved||await first(env,'SELECT * FROM hiring_email_deliveries WHERE shortlist_id=? AND user_id=? AND recipient=? AND report_hash=?',shortlistId,owner,recipient,report.report_hash);if(!row)throw new ApiError(409,'The report or workspace changed. Review again before requesting delivery.');if(row.state==='queued'&&!row.dispatched_at)await dispatch(env,row);return metadata(row);
}
export async function getHiringEmail(env:Env,owner:number,id:string){const row=await first(env,'SELECT * FROM hiring_email_deliveries WHERE id=? AND user_id=?',id,owner);if(!row)throw new ApiError(404,'Hiring email delivery not found');const events=await all(env,'SELECT state,reason,created_at FROM hiring_email_events WHERE delivery_id=? ORDER BY id',id);return{...metadata(row),events};}
export async function processHiringEmail(env:Env,id:string){
 const token=crypto.randomUUID(),now=new Date().toISOString();
 const row=await first(env,`UPDATE hiring_email_deliveries SET state='sending',attempts=1,started_at=?,lease_token=?,lease_expires_at=? WHERE id=? AND state='queued' AND attempts=0 AND expires_at>? AND NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=hiring_email_deliveries.user_id AND state IN ('queued','deleting')) RETURNING *`,now,token,new Date(Date.now()+90000).toISOString(),id,now);if(!row)return;
 const finish=async(state:string,reason:string|null,status:number|null=null,providerId:string|null=null)=>run(env,"UPDATE hiring_email_deliveries SET state=?,failure_reason=?,provider_status=?,provider_message_id=?,accepted_at=CASE WHEN ?='accepted' THEN ? ELSE accepted_at END,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND state='sending' AND lease_token=?",state,reason,status,providerId,state,new Date().toISOString(),new Date().toISOString(),id,token);
 try{
  if(!hiringEmailReadiness(env).ready||String(env.GMAIL_USER).trim().toLowerCase()!==row.sender||!allowed(env,row.recipient)){await finish('cancelled','Gmail sender configuration or recipient authorization changed before delivery.');return;}
  if(await digest(row.payload)!==row.payload_hash){await finish('failed','The immutable hiring email failed its integrity check; no message was sent.');return;}
  const payload=parsed<Row>(row.payload,{});if(payload.from!==row.sender||payload.to!==row.recipient||payload.messageId!==row.message_id||typeof payload.html!=='string'||await digest(payload.html)!==row.report_hash){await finish('failed','The hiring report binding is invalid; no message was sent.');return;}
  const live=await first(env,`SELECT id FROM hiring_email_deliveries WHERE id=? AND state='sending' AND lease_token=? AND lease_expires_at>? AND EXISTS(SELECT 1 FROM users u WHERE u.id=hiring_email_deliveries.user_id) AND NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=hiring_email_deliveries.user_id AND state IN ('queued','deleting'))`,id,token,new Date().toISOString());if(!live)return;
  const outcome=await sendGmailMessage(env,{from:payload.from,to:payload.to,subject:payload.subject,html:payload.html,messageId:payload.messageId,date:payload.date});
  if(outcome.state==='accepted')await finish('accepted',null,outcome.provider_status,outcome.provider_message_id);
  else await finish(outcome.state==='uncertain'?'needs_action':'failed',outcome.state==='uncertain'?uncertain:outcome.failure_reason,outcome.provider_status);
 }catch{await finish('needs_action',uncertain);}
}
export async function recoverHiringEmails(env:Env){
 const now=new Date().toISOString();
 await run(env,"UPDATE hiring_email_deliveries SET state='needs_action',failure_reason=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL WHERE state='sending' AND lease_expires_at<=?",uncertain,now,now);
 await run(env,"UPDATE hiring_email_deliveries SET state='failed',failure_reason='Hiring email request expired before execution; no new message was sent.',finished_at=? WHERE state='queued' AND expires_at<=?",now,now);
 const rows=await all(env,"SELECT * FROM hiring_email_deliveries WHERE state='queued' AND attempts=0 AND expires_at>? AND (dispatched_at IS NULL OR dispatched_at<?) ORDER BY created_at LIMIT 3",now,new Date(Date.now()-300000).toISOString());for(const row of rows)await dispatch(env,row);
}
