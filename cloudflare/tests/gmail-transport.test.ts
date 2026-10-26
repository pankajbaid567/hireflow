/** Actual Nodemailer SMTP/MIME over an isolated Duplex; never opens a socket. */
import {beforeEach,afterEach,describe,expect,it,vi} from 'vitest';
import type {Env} from '../src/types';
const wire=vi.hoisted(()=>({mode:'accepted',commands:[] as string[],messages:[] as string[],options:[] as Record<string,any>[],closed:0}));
vi.mock('node:tls',async()=>{
 const actual=await vi.importActual<typeof import('node:tls')>('node:tls'),{Duplex}=await import('node:stream');
 class FixtureSocket extends Duplex {
  encrypted=true;authorized=true;remoteAddress='fixture';remotePort=465;dataMode=false;buffer='';
  _read(){}
  setTimeout(){return this;}setKeepAlive(){return this;}setNoDelay(){return this;}ref(){return this;}unref(){return this;}
  constructor(){super();queueMicrotask(()=>{if(wire.mode==='tls-error'){this.destroy(new Error('private Gmail App Password fixture-marker'));return;}this.emit('secureConnect');this.push('220 fixture ESMTP ready\r\n');});}
  _write(chunk:Buffer,_encoding:string,callback:(error?:Error|null)=>void){
   this.buffer+=chunk.toString();
   if(this.dataMode){const end=this.buffer.indexOf('\r\n.\r\n');if(end>=0){wire.messages.push(this.buffer.slice(0,end));this.buffer=this.buffer.slice(end+5);this.dataMode=false;if(wire.mode==='lost-final-ack')this.destroy();else this.push('250 2.0.0 accepted by fixture\r\n');}callback();return;}
   for(;;){const end=this.buffer.indexOf('\r\n');if(end<0)break;const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+2);wire.commands.push(line);
    if(/^EHLO /.test(line))this.push('250-fixture\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 524288\r\n');
    else if(/^AUTH /.test(line))this.push(wire.mode==='auth-rejected'?'535 5.7.8 private-secret-provider-diagnostic\r\n':'235 2.7.0 authenticated\r\n');
    else if(/^MAIL FROM:/.test(line))this.push('250 2.1.0 sender accepted\r\n');
    else if(/^RCPT TO:/.test(line))this.push(wire.mode==='recipient-rejected'?'550 5.1.1 private-recipient-diagnostic\r\n':'250 2.1.5 recipient accepted\r\n');
    else if(line==='DATA'){if(wire.mode==='data-rejected')this.push('552 5.3.4 private-size-diagnostic\r\n');else{this.dataMode=true;this.push('354 End with dot\r\n');}break;}
    else if(line==='QUIT')this.push('221 closing fixture\r\n');
    else this.push('500 unsupported fixture command\r\n');
   }callback();
  }
  _destroy(error:Error|null,callback:(error:Error|null)=>void){wire.closed++;callback(error);}
 }
 const connect=(options:Record<string,any>)=>{wire.options.push(options);if(wire.mode==='connect-throw')throw new Error('private synchronous TLS failure');return new FixtureSocket();};return{...actual,default:{...actual,connect},connect};
});
import {gmailReadiness,gmailRecipientAllowed,probeGmailConnection,sendGmailMessage,type GmailMessage} from '../src/gmail_transport';
let attempts:number;
const message=():GmailMessage=>({from:'sender@gmail.com',to:'sender@gmail.com',subject:'Private HireFlow report',html:'<p>Private report</p>',messageId:'<12345678-1234-4123-8123-123456789abc@hireflow.invalid>',date:'2026-10-26T00:00:00.000Z',attachments:[{filename:'resume_v2.pdf',content:Buffer.from('%PDF-1.4 local fixture').toString('base64')}]});
function environment(values:Partial<Env>={}):Env{return{GMAIL_USER:'sender@gmail.com',GMAIL_APP_PASSWORD:'abcdefghijklmnop',FROM_EMAIL:'sender@gmail.com',DB:{prepare(){return{bind(_day:string,limit:number){return{async first(){if(attempts>=limit)return null;return{attempts:++attempts};}};}};}},...values} as Env;}
beforeEach(()=>{wire.mode='accepted';wire.commands=[];wire.messages=[];wire.options=[];wire.closed=0;attempts=0;});
afterEach(()=>{vi.restoreAllMocks();});
describe('fixed Gmail SMTP transport',()=>{
 it('uses actual Nodemailer MIME/AUTH/DATA and accepts only the final250 with no delivery claim',async()=>{
  const result=await sendGmailMessage(environment(),message());expect(result).toEqual({state:'accepted',provider_message_id:message().messageId,provider_status:250});expect(attempts).toBe(1);expect(wire.options).toEqual([{host:'smtp.gmail.com',port:465,servername:'smtp.gmail.com',minVersion:'TLSv1.2',rejectUnauthorized:true}]);expect(wire.commands.filter(line=>/^MAIL FROM:/.test(line))).toHaveLength(1);expect(wire.commands.filter(line=>/^RCPT TO:/.test(line))).toEqual(['RCPT TO:<sender@gmail.com>']);expect(wire.messages).toHaveLength(1);expect(wire.messages[0]).toContain('Message-ID: '+message().messageId);expect(wire.messages[0]).toContain('Date: Mon, 26 Oct 2026 00:00:00 +0000');expect(wire.messages[0]).toContain('Content-Type: application/pdf');expect(wire.messages[0]).toContain(message().attachments![0].content);expect(wire.closed).toBe(1);expect(JSON.stringify(result)).not.toMatch(/delivered|abcdefghijklmnop|sender@gmail/);
 });
 it('cannot send or authenticate from its credential-free native probe',async()=>{
  expect(await probeGmailConnection()).toMatchObject({state:'verified',host:'smtp.gmail.com',port:465,authenticated:false,email_sent:false});expect(wire.commands).toEqual(['EHLO hireflow.invalid','QUIT']);expect(wire.messages).toEqual([]);expect(attempts).toBe(0);expect(wire.closed).toBe(1);
 });
 it.each(['auth-rejected','recipient-rejected','data-rejected'])('records explicit %s without exposing diagnostics or automatically trying again',async mode=>{
  wire.mode=mode;const result=await sendGmailMessage(environment(),message());expect(result.state).toBe('rejected');expect(result.provider_status).toBe(mode==='auth-rejected'?535:mode==='recipient-rejected'?550:552);expect(wire.options).toHaveLength(1);expect(wire.messages).toHaveLength(0);expect(JSON.stringify(result)).not.toMatch(/private-|abcdefghijklmnop|sender@gmail/);expect(attempts).toBe(1);
 });
 it.each(['lost-final-ack','tls-error','connect-throw'])('treats %s as uncertain with no duplicate SMTP attempt and a charged allowance',async mode=>{
  wire.mode=mode;const result=await sendGmailMessage(environment(),message());expect(result).toMatchObject({state:'uncertain',provider_status:null});expect(result.state==='uncertain'&&result.failure_reason).toContain('automatic resend is disabled');expect(wire.options).toHaveLength(1);expect(attempts).toBe(1);expect(JSON.stringify(result)).not.toMatch(/fixture-marker|abcdefghijklmnop|sender@gmail/);
 });
 it('defaults to self-only recipients and privately expands only exact approved addresses',async()=>{
  const env=environment();expect(gmailRecipientAllowed(env,'other@example.com')).toBe(false);expect((await sendGmailMessage(env,{...message(),to:'other@example.com'})).state).toBe('rejected');expect(wire.options).toEqual([]);expect(attempts).toBe(0);
  const allowed=environment({GMAIL_ALLOWED_RECIPIENTS:'owner@example.com,team@example.com'});expect(gmailRecipientAllowed(allowed,'team@example.com')).toBe(true);expect(gmailRecipientAllowed(allowed,'team@example.com.attacker.test')).toBe(false);expect((await sendGmailMessage(allowed,{...message(),to:'team@example.com'})).state).toBe('accepted');expect(JSON.stringify(gmailReadiness(allowed))).not.toContain('team@example.com');
 });
 it.each([{GMAIL_APP_PASSWORD:undefined},{GMAIL_APP_PASSWORD:'normal-account-password'},{GMAIL_USER:'not-an-email'},{GMAIL_ALLOWED_RECIPIENTS:'*'},{GMAIL_ALLOWED_RECIPIENTS:'x@example.com\r\nBcc: attacker@example.com'}])('fails closed on invalid private configuration%j',async values=>{
  const env=environment(values);expect(gmailReadiness(env).ready).toBe(false);expect((await sendGmailMessage(env,message())).state).toBe('rejected');expect(wire.options).toEqual([]);expect(attempts).toBe(0);
 });
 it.each([{subject:'Report\r\nBcc: attacker@example.com'},{from:'sender@gmail.com\r\nMAIL FROM:<attacker@example.com>'},{to:'sender@gmail.com,other@example.com'},{messageId:'<x>\r\nBcc:other@example.com'},{attachments:[{filename:'../../secret.pdf',content:'JVBERS0='}]},{attachments:[{filename:'secret.pdf',content:Buffer.from('not a PDF').toString('base64')}]}])('rejects unsafe message fields before network or quota reservation%j',async changes=>{
  expect((await sendGmailMessage(environment(),{...message(),...changes})).state).toBe('rejected');expect(wire.options).toEqual([]);expect(attempts).toBe(0);
 });
 it('keeps SMTP dot termination inside the MIME body instead of adding another envelope',async()=>{
  const result=await sendGmailMessage(environment(),{...message(),attachments:[],html:'<p>Report</p>\r\n.\r\nMAIL FROM:<attacker@example.com>'});expect(result.state).toBe('accepted');expect(wire.messages).toHaveLength(1);expect(wire.messages[0]).toContain('\r\n..\r\n');expect(wire.commands.filter(line=>/^MAIL FROM:/.test(line))).toHaveLength(1);
 });
 it('shares the same daily allowance across messages, clamps limits and never refunds an uncertain attempt',async()=>{
  const env=environment({GMAIL_DAILY_ATTEMPT_LIMIT:'1'});wire.mode='lost-final-ack';expect((await sendGmailMessage(env,message())).state).toBe('uncertain');wire.mode='accepted';const denied=await sendGmailMessage(env,{...message(),messageId:'<second@hireflow.invalid>'});expect(denied.state).toBe('rejected');expect(denied.state==='rejected'&&denied.failure_reason).toContain('allowance');expect(attempts).toBe(1);expect(wire.options).toHaveLength(1);
 });
 it('clamps a configured daily limit above20 and defaults a malformed limit to10',async()=>{
  attempts=19;const env=environment({GMAIL_DAILY_ATTEMPT_LIMIT:'1000'});expect((await sendGmailMessage(env,message())).state).toBe('accepted');expect((await sendGmailMessage(env,message())).state).toBe('rejected');expect(attempts).toBe(20);attempts=10;expect((await sendGmailMessage(environment({GMAIL_DAILY_ATTEMPT_LIMIT:'invalid'}),message())).state).toBe('rejected');expect(wire.options).toHaveLength(1);
 });
 it('fails closed when the quota cannot be persisted and opens no SMTP connection',async()=>{
  const unavailable=()=>{throw new Error('private database detail');};const env=environment({DB:{prepare:unavailable,batch:unavailable,exec:unavailable,withSession:unavailable,dump:unavailable}});const result=await sendGmailMessage(env,message());expect(result.state).toBe('rejected');expect(wire.options).toEqual([]);expect(JSON.stringify(result)).not.toContain('private database detail');
 });
});
