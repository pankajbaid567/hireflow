import {ApiError,type Env,type Row,parsed,json} from './types';
import {all,first,run,userById} from './storage';
import {requireUser} from './auth';
import {readJson} from './profile';
import {startDiscoveryCycle,discoveryCycleStatus,changeDiscoveryCycle} from './discovery_cycles';
import {getPlan} from './plans';
import {generateReport,emailReport} from './reports';
import {emailReadiness} from './email_delivery';

const day=86400000;
// Public timezone formatters contain no owner data; bound isolate-local reuse.
const formatters=new Map<string,Intl.DateTimeFormat>();
function parts(date:Date,zone:string){let formatter=formatters.get(zone);if(!formatter){formatter=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});if(formatters.size>=16)formatters.delete(formatters.keys().next().value!);formatters.set(zone,formatter);}const result=formatter.formatToParts(date);return Object.fromEntries(result.filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
function civil(date:Date,zone:string){const p=parts(date,zone);return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute);}
/** Resolve wall time by observed offsets: folds choose the first occurrence;
 * nonexistent spring times move forward by the gap. No minute-by-minute scan. */
export function zonedInstant(wall:number,zone:string){const offsets=[-2,-1,0,1,2].map(d=>{const at=new Date(wall+d*day);return civil(at,zone)-at.getTime();});const candidates=[...new Set(offsets)].map(offset=>wall-offset);const exact=candidates.filter(at=>civil(new Date(at),zone)===wall);if(exact.length)return Math.min(...exact);const later=candidates.filter(at=>civil(new Date(at),zone)>wall).sort((a,b)=>civil(new Date(a),zone)-civil(new Date(b),zone));if(!later.length)throw new ApiError(422,'Cannot resolve this timezone.');return later[0];}
function localMonday(now:Date,zone:string){const p=parts(now,zone),at=Date.UTC(p.year,p.month-1,p.day);return at-((new Date(at).getUTCDay()+6)%7)*day;}
export function scheduledWindow(settings:Row,now=new Date()){
 const monday=localMonday(now,settings.timezone),offset=((settings.weekday+6)%7)*day+(settings.hour*60+settings.minute)*60000;
 const current=zonedInstant(monday+offset,settings.timezone),next=zonedInstant(monday+7*day+offset,settings.timezone);
 return {local_week:new Date(monday).toISOString().slice(0,10),current:new Date(current).toISOString(),next:new Date(current>now.getTime()?current:next).toISOString()};
}
function integer(value:unknown,fallback:number,min:number,max:number){if(value===undefined)return fallback;const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new ApiError(422,'Invalid schedule value.');return n;}
function settings(body:Row,previous:Row={}){const timezone=String(body.timezone??previous.timezone??'Asia/Kolkata');try{parts(new Date(),timezone);}catch{throw new ApiError(422,'Choose a valid IANA timezone.');}for(const key of ['enabled','prepare_guides','email_opt_in'])if(body[key]!==undefined&&typeof body[key]!=='boolean')throw new ApiError(422,`${key} must be true or false.`);return{timezone,weekday:integer(body.weekday,previous.weekday??1,0,6),hour:integer(body.hour,previous.hour??9,0,23),minute:integer(body.minute,previous.minute??0,0,59),discovery_target:integer(body.discovery_target,previous.discovery_target??20,1,50),enabled:body.enabled===undefined?Boolean(previous.enabled):body.enabled,prepare_guides:body.prepare_guides===undefined?previous.prepare_guides!==0:body.prepare_guides,email_opt_in:body.email_opt_in===undefined?Boolean(previous.email_opt_in):body.email_opt_in};}
function publicSettings(row:Row){return{...row,enabled:Boolean(row.enabled),prepare_guides:Boolean(row.prepare_guides),email_opt_in:Boolean(row.email_opt_in),submission_policy:'Drafts and reminders only. Each application still requires your review and confirmation.'};}
export async function schedulerRoutes(request:Request,env:Env):Promise<Response|null>{
 const path=new URL(request.url).pathname;if(!['/account/schedule','/account/reminders'].includes(path))return null;const owner=await requireUser(request,env);
 if(path==='/account/reminders'&&request.method==='GET')return json({items:await all(env,'SELECT id,message,created_at,read_at FROM workspace_reminders WHERE user_id=? ORDER BY created_at DESC LIMIT 20',owner)});
 if(path==='/account/schedule'&&request.method==='GET'){const row=await first(env,'SELECT * FROM weekly_schedules WHERE user_id=?',owner);const history=await all(env,'SELECT id,local_week,state,stage,reason,created_at,finished_at FROM weekly_schedule_runs WHERE user_id=? ORDER BY created_at DESC LIMIT 8',owner);return json({settings:publicSettings(row||{...settings({}),enabled:false,next_run_at:null,version:0}),runs:history});}
 if(path==='/account/schedule'&&request.method==='PUT'){
  const previous=await first(env,'SELECT * FROM weekly_schedules WHERE user_id=?',owner),input=settings(await readJson(request),previous||{}),next=scheduledWindow(input).next;
  if(input.email_opt_in&&!emailReadiness(env).ready)throw new ApiError(409,'Set up a verified email provider before enabling weekly delivery.');
  await env.DB.batch([
   env.DB.prepare("UPDATE discovery_cycles SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,finished_at=?,failure_reason='Weekly preparation paused or changed. Verified opportunities are retained.' WHERE user_id=? AND state IN ('queued','running','paused') AND schedule_run_id IN (SELECT id FROM weekly_schedule_runs WHERE user_id=? AND state IN ('queued','running','waiting'))").bind(new Date().toISOString(),owner,owner),
   env.DB.prepare("UPDATE discovery_candidates SET state='pending',claim_token=NULL WHERE state='claimed' AND cycle_id IN (SELECT id FROM discovery_cycles WHERE user_id=? AND state='cancelled' AND schedule_run_id IS NOT NULL)").bind(owner),
   env.DB.prepare('INSERT INTO weekly_schedules(user_id,enabled,timezone,weekday,hour,minute,discovery_target,prepare_guides,email_opt_in,next_run_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,timezone=excluded.timezone,weekday=excluded.weekday,hour=excluded.hour,minute=excluded.minute,discovery_target=excluded.discovery_target,prepare_guides=excluded.prepare_guides,email_opt_in=excluded.email_opt_in,next_run_at=excluded.next_run_at,version=weekly_schedules.version+1,updated_at=excluded.updated_at').bind(owner,Number(input.enabled),input.timezone,input.weekday,input.hour,input.minute,input.discovery_target,Number(input.prepare_guides),Number(input.email_opt_in),input.enabled?next:null,new Date().toISOString()),
   env.DB.prepare("UPDATE weekly_schedule_runs SET state='cancelled',reason='Schedule paused or changed. Existing drafts remain available.',lease_token=NULL,finished_at=? WHERE user_id=? AND state IN ('queued','waiting','running')").bind(new Date().toISOString(),owner),
  ]);return json({settings:publicSettings((await first(env,'SELECT * FROM weekly_schedules WHERE user_id=?',owner))!)});
 }throw new ApiError(405,'Method not allowed');
}
async function dispatch(env:Env,row:Row){try{const seconds=Math.max(0,Math.min(300,Math.ceil((Date.parse(row.next_wake_at||'')-Date.now())/1000)||0));await env.APPLICATION_QUEUE.send({kind:'weekly_schedule',run_id:row.id},{delaySeconds:seconds});await run(env,"UPDATE weekly_schedule_runs SET dispatched_at=? WHERE id=? AND state IN ('queued','waiting')",new Date().toISOString(),row.id);}catch{/* Cron recovers the durable ticket. */}}
export async function recoverWeeklySchedules(env:Env,now=new Date()){
 const iso=now.toISOString();
 const due=await all(env,'SELECT * FROM weekly_schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 5',iso);
 for(const s of due){const window=scheduledWindow(s,now),user=await userById(env,s.user_id),id=crypto.randomUUID();
  // A long outage catches up the latest due local week only, not an unbounded backlog.
  const latestDue=window.current<=iso?window.local_week:new Date(Date.parse(window.local_week)-7*day).toISOString().slice(0,10);
  const inserted=await first(env,`INSERT INTO weekly_schedule_runs(id,user_id,local_week,schedule_version,profile_version,settings,created_at,expires_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM weekly_schedules WHERE user_id=? AND version=? AND enabled=1 AND next_run_at<=?) ON CONFLICT(user_id,local_week) DO NOTHING RETURNING *`,id,s.user_id,latestDue,s.version,user.profile_version,JSON.stringify(s),iso,new Date(now.getTime()+48*3600000).toISOString(),s.user_id,s.version,iso);
  await run(env,'UPDATE weekly_schedules SET next_run_at=? WHERE user_id=? AND version=? AND next_run_at<=?',window.next,s.user_id,s.version,iso);if(inserted)await dispatch(env,inserted);
 }
 await env.DB.batch([
  env.DB.prepare("UPDATE weekly_schedule_runs SET state='failed',reason='Scheduled draft work expired; start discovery manually.',finished_at=?,lease_token=NULL WHERE state IN ('queued','running','waiting') AND expires_at<=?").bind(iso,iso),
  env.DB.prepare("UPDATE weekly_schedule_runs SET state='queued',lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE state='running' AND lease_expires_at<=? AND expires_at>?").bind(iso,iso),
 ]);
 for(const row of await all(env,"SELECT * FROM weekly_schedule_runs WHERE state IN ('queued','waiting') AND (dispatched_at IS NULL OR dispatched_at<?) AND (next_wake_at IS NULL OR next_wake_at<=?) ORDER BY created_at LIMIT 5",new Date(now.getTime()-600000).toISOString(),iso))await dispatch(env,row);
}
export async function processWeeklySchedule(env:Env,id:string){
 const now=new Date().toISOString(),token=crypto.randomUUID();
 const row=await first(env,`UPDATE weekly_schedule_runs SET state='running',lease_token=?,lease_expires_at=?,attempts=attempts+1 WHERE id=? AND state IN ('queued','waiting') AND (next_wake_at IS NULL OR next_wake_at<=?) AND expires_at>? RETURNING *`,token,new Date(Date.now()+120000).toISOString(),id,now,now);if(!row)return;
 const owner=row.user_id,s=parsed<Row>(row.settings,{}),user=await userById(env,owner);
 const valid=()=>first(env,"SELECT r.id FROM weekly_schedule_runs r JOIN weekly_schedules s ON s.user_id=r.user_id JOIN users u ON u.id=r.user_id WHERE r.id=? AND r.lease_token=? AND r.state='running' AND s.enabled=1 AND s.version=r.schedule_version AND u.profile_version=r.profile_version",id,token);
 const save=async(stage:string,extra:Row={},delay=0)=>{const updated=await first(env,"UPDATE weekly_schedule_runs SET stage=?,state='waiting',discovery_id=COALESCE(?,discovery_id),application_ids=COALESCE(?,application_ids),guide_cursor=COALESCE(?,guide_cursor),reason=?,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL,next_wake_at=? WHERE id=? AND lease_token=? RETURNING *",stage,extra.discovery_id??null,extra.application_ids?JSON.stringify(extra.application_ids):null,extra.guide_cursor??null,extra.reason??null,new Date(Date.now()+delay*1000).toISOString(),id,token);if(updated)await dispatch(env,updated);};
 try{
  if(!await valid()){await run(env,"UPDATE weekly_schedule_runs SET state='cancelled',reason='Profile or schedule changed. Review fresh drafts manually.',lease_token=NULL,finished_at=? WHERE id=? AND lease_token=?",now,id,token);return;}
  if(row.stage==='discovery'){
   const cycle=row.discovery_id?await discoveryCycleStatus(env,owner,row.discovery_id):await startDiscoveryCycle(env,owner,{target:s.discovery_target,max_search_calls:Math.max(6,Math.ceil(s.discovery_target/5)),max_detail_checks:s.discovery_target*3,schedule_run_id:id});
   if(['queued','running'].includes(cycle.state)){await save('discovery',{discovery_id:cycle.id},60);return;}
   if(cycle.state==='paused'){if(cycle.next_retry_at&&Date.parse(cycle.next_retry_at)<=Date.now()&&await valid())await changeDiscoveryCycle(env,owner,cycle.id,'resume');await save('discovery',{discovery_id:cycle.id,reason:cycle.message},300);return;}
   await save('plan',{discovery_id:cycle.id,reason:cycle.state==='completed'?null:cycle.message});return;
  }
  if(row.stage==='plan'){const plan=await getPlan(env,owner);if(!await valid())return;if(plan.preparing){await save('plan',{},60);return;}await save(s.prepare_guides?'guides':'report',{application_ids:plan.plan.map((item:Row)=>item.application_id)});return;}
  if(row.stage==='guides'){
   const ids=parsed<number[]>(row.application_ids,[]),app=ids[row.guide_cursor];
   if(app){const guide=await first(env,'SELECT id FROM prep_guides WHERE application_id=?',app);if(!guide){await env.APPLICATION_QUEUE.send({kind:'prep',application_id:app});await save('guides',{reason:'Preparing interview guides; application submission still requires review.'},120);return;}await save('guides',{guide_cursor:row.guide_cursor+1});return;}
   await save('report');return;
  }
  if(row.stage==='report'){await generateReport(env,owner);if(!await valid())return;await save(s.email_opt_in?'email':'reminder');return;}
  if(row.stage==='email'){if(!await valid())return;await emailReport(env,owner,{schedule_run_id:id,schedule_version:row.schedule_version});await save('reminder');return;}
  if(row.stage==='reminder'){
   await env.DB.batch([
    env.DB.prepare("INSERT INTO workspace_reminders(id,user_id,run_id,message,created_at) SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM weekly_schedule_runs WHERE id=? AND lease_token=? AND state='running') ON CONFLICT(run_id) DO NOTHING").bind(crypto.randomUUID(),owner,id,'Your weekly drafts and report are ready. Review every resume and answer before confirming applications.',now,id,token),
    env.DB.prepare("UPDATE weekly_schedule_runs SET state='completed',stage='done',lease_token=NULL,finished_at=? WHERE id=? AND lease_token=?").bind(now,id,token),
   ]);return;
  }
  throw new Error('Unknown stage');
 }catch{
  if(row.attempts>=20){await run(env,"UPDATE weekly_schedule_runs SET state='failed',reason='Scheduled preparation could not finish within its retry budget. Retained drafts remain available.',lease_token=NULL,finished_at=? WHERE id=? AND lease_token=?",now,id,token);return;}
  await save(row.stage,{reason:'A provider or storage service is unavailable. Retrying draft preparation.'},Math.min(300,15*2**Math.min(4,row.attempts)));
 }
}
