/** Fixed-host Gmail submission. SMTP acceptance never establishes inbox delivery. */
import {connect,type TLSSocket} from 'node:tls';
import {Buffer} from 'node:buffer';
import type {SMTPTransportOptions,SMTPSentMessageInfo} from 'nodemailer/lib/smtp-transport';
import type Mail from 'nodemailer/lib/mailer';
import type {Env} from './types';

export type GmailMessage={from:string;to:string;subject:string;html:string;attachments?:Array<{filename:string;content:string}>;messageId:string;date?:string};
export type GmailOutcome={state:'accepted';provider_message_id:string;provider_status:250}|{state:'rejected'|'uncertain';provider_status:number|null;failure_reason:string};
const host='smtp.gmail.com',port=465,operationMs=20_000;
const mailbox=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value);
const rejected=(reason:string,status:number|null=null):GmailOutcome=>({state:'rejected',provider_status:status,failure_reason:reason});
const uncertain:GmailOutcome={state:'uncertain',provider_status:null,failure_reason:'Gmail submission outcome is uncertain. Check the sender Sent folder and the intended recipient before requesting another report; automatic resend is disabled.'};
function credentials(env:Env){
 const user=String(env.GMAIL_USER||'').trim(),pass=String(env.GMAIL_APP_PASSWORD||'').replace(/\s/g,'');
 if(!mailbox(user)||!/^[A-Za-z0-9]{16}$/.test(pass))return null;
 const extra=String(env.GMAIL_ALLOWED_RECIPIENTS||'').trim();if(extra.length>2600)return null;
 const recipients=extra?extra.split(',').map(value=>value.trim()):[];
 if(recipients.length>10||recipients.some(value=>!mailbox(value)))return null;
 return{user,pass,sender:user,recipients:new Set([user.toLowerCase(),...recipients.map(value=>value.toLowerCase())])};
}
export function gmailReadiness(env:Env){return{ready:Boolean(credentials(env)),reason:'Configure GMAIL_USER and its 16-character GMAIL_APP_PASSWORD privately. Gmail recipients are restricted to the sender or an operator-configured private allowlist.'};}
export function gmailRecipientAllowed(env:Env,recipient:string){const config=credentials(env);return Boolean(config&&mailbox(recipient)&&config.recipients.has(recipient.toLowerCase()));}
function prepared(message:GmailMessage,config:NonNullable<ReturnType<typeof credentials>>){
 if(!message||!mailbox(message.from)||message.from.toLowerCase()!==config.user.toLowerCase()||!mailbox(message.to)||!config.recipients.has(message.to.toLowerCase()))return null;
 if(typeof message.subject!=='string'||!message.subject.trim()||Buffer.byteLength(message.subject)>200||/[\x00-\x1f\x7f]/.test(message.subject))return null;
 if(typeof message.html!=='string'||Buffer.byteLength(message.html)>250000||typeof message.messageId!=='string'||!/^<[A-Za-z0-9_.-]{1,128}@[A-Za-z0-9.-]{1,128}>$/.test(message.messageId))return null;
 if(message.date!==undefined&&(typeof message.date!=='string'||!/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(message.date)||!Number.isFinite(Date.parse(message.date))))return null;
 if(message.attachments!==undefined&&!Array.isArray(message.attachments)||message.attachments&&message.attachments.length>10)return null;
 const attachments:Array<{filename:string;content:Buffer;contentType:string}>=[];let total=0;
 for(const attachment of message.attachments||[]){
  if(!attachment||typeof attachment.filename!=='string'||!/^[-A-Za-z0-9_ .]{1,120}\.pdf$/i.test(attachment.filename)||typeof attachment.content!=='string'||attachment.content.length>180000||attachment.content.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(attachment.content))return null;
  const content=Buffer.from(attachment.content,'base64');total+=content.length;if(total>128*1024||content.subarray(0,5).toString('ascii')!=='%PDF-')return null;
  attachments.push({filename:attachment.filename,content,contentType:'application/pdf'});
 }
 return{from:config.user,to:message.to,subject:message.subject,html:message.html,messageId:message.messageId,...(message.date?{date:new Date(message.date)}:{}),attachments,envelope:{from:config.user,to:[message.to]},disableFileAccess:true,disableUrlAccess:true};
}
type GmailClient=Mail<SMTPSentMessageInfo,SMTPTransportOptions>;
async function gmailSession<T>(auth:{user:string;pass:string}|undefined,operation:(client:GmailClient)=>Promise<T>):Promise<T>{
 let socket:TLSSocket|undefined,cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
 const active=()=>{if(cancelled)throw new Error('Gmail operation ended.');};
 try{
  return await Promise.race([async function():Promise<T>{
   const {createTransport}=await import('nodemailer');active();
   const options:SMTPTransportOptions={host,port,secure:true,name:'hireflow.invalid',pool:false,...(auth?{auth}:{}),authMethod:'PLAIN',connectionTimeout:8000,greetingTimeout:5000,socketTimeout:10000,dnsTimeout:5000,logger:false,debug:false,transactionLog:false,disableFileAccess:true,disableUrlAccess:true,maxRecipients:1,tls:{servername:host,minVersion:'TLSv1.2',rejectUnauthorized:true},
    getSocket:(_options,callback)=>{
     if(cancelled){callback(new Error('Gmail operation ended.'));return;}
     // Keep the exact socket so a deadline can terminate an in-flight DATA
     // exchange. Never accept an SMTP host, proxy, TLS setting or auth from JSON.
     try{
      socket=connect({host,port,servername:host,minVersion:'TLSv1.2',rejectUnauthorized:true});
      let returned=false;const failure=(error:Error)=>{if(returned)return;returned=true;callback(error);};socket.once('error',failure);
      socket.once('secureConnect',()=>{socket!.removeListener('error',failure);if(returned)return;returned=true;if(cancelled){socket!.destroy();callback(new Error('Gmail operation ended.'));return;}callback(null,{connection:socket!,secured:true});});
     }catch(error){callback(error instanceof Error?error:new Error('Gmail TLS socket unavailable.'));}
    }};
   const transporter=createTransport(options);
   try{
    active();return await operation(transporter);
   }finally{transporter.close();}
  }(),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{cancelled=true;socket?.destroy();reject(new Error('Gmail operation deadline exceeded.'));},operationMs);})]);
 }finally{cancelled=true;clearTimeout(timer);socket?.destroy();}
}
/** Credential-free native compatibility probe: TLS/EHLO/QUIT, never mail/auth. */
export async function probeGmailConnection(){
 try{await gmailSession(undefined,async client=>{await client.verify();});return{state:'verified' as const,host,port,tls:true,authenticated:false,email_sent:false};}
 catch{return{state:'failed' as const,host,port,tls:true,authenticated:false,email_sent:false,reason:'The bounded Gmail TLS/EHLO compatibility probe did not complete.'};}
}
/** One SMTP transaction, no pooling or automatic retry; all failure text is fixed. */
export async function sendGmailMessage(env:Env,message:GmailMessage):Promise<GmailOutcome>{
 const config=credentials(env);if(!config)return rejected(gmailReadiness(env).reason);
 const mail=prepared(message,config);if(!mail)return rejected('Gmail delivery rejected unsafe message data or a recipient outside the private sender allowlist. No SMTP connection was opened.');
 try{return await gmailSession({user:config.user,pass:config.pass},async client=>{
  // Both weekly and hiring sends reserve this same global Free-demo allowance.
  // Interrupted or unknown outcomes remain charged; SMTP has no idempotency key.
  const raw=Number(env.GMAIL_DAILY_ATTEMPT_LIMIT??10),limit=Number.isFinite(raw)?Math.max(1,Math.min(20,Math.floor(raw))):10,day=new Date().toISOString().slice(0,10);
  let allowance:unknown;
  try{allowance=await env.DB.prepare('INSERT INTO gmail_daily_usage(day,attempts) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET attempts=attempts+1 WHERE attempts<? RETURNING attempts').bind(day,limit).first();}
  catch{return rejected('The shared Gmail allowance could not be recorded. No SMTP connection was opened.');}
  if(!allowance)return rejected('The shared daily Gmail attempt allowance is exhausted. No SMTP connection was opened; wait until the next UTC day.');
  const info=await client.sendMail(mail);
  if(!/^250(?:[ -]|$)/.test(String(info.response))||info.accepted.length!==1||info.accepted[0].toLowerCase()!==message.to.toLowerCase()||info.rejected.length||info.messageId!==message.messageId)return uncertain;
  return{state:'accepted',provider_message_id:message.messageId,provider_status:250};
 });}catch(error){
  const status=error&&typeof error==='object'&&'responseCode'in error?Number(error.responseCode):NaN;
  return Number.isInteger(status)&&status>=400&&status<=599?rejected('Gmail rejected this SMTP transaction. Check the App Password, sender account, recipient and Gmail sending limits before requesting another report.',status):uncertain;
 }
}
