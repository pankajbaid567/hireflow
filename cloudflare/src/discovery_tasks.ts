/** Owner-scoped read-only discovery jobs. Never authorize an application. */
import { ApiError, type Env, type Row, parsed } from './types';
import { all, first, run, userById } from './storage';
import { discoverJobs } from './intelligence';
import { addJobs } from './plans';
import { validatePublicUrl } from './automation';
import {newOperationContext} from './telemetry';

const lifetime=5*60_000;
const expiredReason='Job search expired before it could finish. Start a new search; existing opportunities are preserved.';
const staleReason='Your profile or mode changed during job search. Start a new search with your current preferences.';
export async function recoverDiscovery(env:Env){
  const now=new Date().toISOString();
  await run(env,"UPDATE discovery_runs SET state='failed',failure_reason=?,finished_at=? WHERE state IN ('queued','running') AND expires_at<=?",expiredReason,now,now);
  const queued=await all(env,"SELECT id FROM discovery_runs WHERE state='queued' AND dispatched_at IS NULL AND expires_at>? ORDER BY created_at LIMIT 3",now);
  for(const row of queued){try{await env.APPLICATION_QUEUE.send({kind:'discover',discovery_id:row.id});await run(env,"UPDATE discovery_runs SET dispatched_at=? WHERE id=? AND state='queued'",now,row.id);}catch{/* Persisted ticket will be recovered by the next cron. */}}
  await run(env,"DELETE FROM discovery_runs WHERE state IN ('completed','failed') AND created_at<?",new Date(Date.now()-7*86400_000).toISOString());
}
function ticket(row:Row){return {discovery_id:row.id,state:row.state,poll_url:`/jobs/${row.user_id}/discover/${row.id}`};}
export async function startDiscovery(env:Env,userId:number){
  const now=Date.now(),iso=new Date(now).toISOString();
  const snapshot=await env.DB.batch([
    env.DB.prepare("UPDATE discovery_runs SET state='failed',failure_reason=CASE WHEN expires_at<=? THEN ? ELSE ? END,finished_at=? WHERE user_id=? AND state IN ('queued','running') AND (expires_at<=? OR profile_version<>(SELECT profile_version FROM users WHERE id=?))").bind(iso,expiredReason,staleReason,iso,userId,iso,userId),
    env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId),
    env.DB.prepare("SELECT id,user_id,state FROM discovery_runs WHERE user_id=? AND state IN ('queued','running')").bind(userId),
  ]);
  const user=snapshot[1].results[0] as Row|undefined,active=snapshot[2].results[0] as Row|undefined;
  if(!user)throw new ApiError(404,'Profile not found');
  user.master_profile=parsed(user.master_profile,{});
  if(active)return ticket(active);
  const cutoff=now-600_000;
  const allowed=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END WHERE window_start<=? OR attempts<3 RETURNING attempts`,`discovery:${userId}`,now,cutoff,cutoff,cutoff);
  if(!allowed)throw new ApiError(429,'Three job searches were requested. Please wait ten minutes before starting another search.');
  const id=crypto.randomUUID();
  const inserted=await first(env,`INSERT INTO discovery_runs(id,user_id,profile_version,mode,profile_snapshot,created_at,expires_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING *`,id,userId,user.profile_version,user.mode,JSON.stringify({...user.master_profile,mode:user.mode}),iso,new Date(now+lifetime).toISOString());
  const row=inserted||await first(env,"SELECT * FROM discovery_runs WHERE user_id=? AND state IN ('queued','running')",userId);
  if(!row)throw new ApiError(409,'Your workspace changed. Please refresh before starting job search.');
  if(inserted)try{await env.APPLICATION_QUEUE.send({kind:'discover',discovery_id:id});await run(env,"UPDATE discovery_runs SET dispatched_at=? WHERE id=? AND state='queued'",new Date().toISOString(),id);}catch{/* The durable queued ticket is retried by cron. */}
  return ticket(row);
}
export async function discoveryStatus(env:Env,userId:number,id:string){
  const now=new Date().toISOString();
  const snapshot=await env.DB.batch([
    env.DB.prepare("UPDATE discovery_runs SET state='failed',failure_reason=?,finished_at=? WHERE id=? AND user_id=? AND state IN ('queued','running') AND expires_at<=?").bind(expiredReason,now,id,userId,now),
    env.DB.prepare('SELECT id,user_id,state,result_json,failure_reason,created_at,finished_at FROM discovery_runs WHERE id=? AND user_id=?').bind(id,userId),
  ]);
  const row=snapshot[1].results[0] as Row|undefined;
  if(!row)throw new ApiError(404,'Job search not found');
  return {...ticket(row),created_at:row.created_at,finished_at:row.finished_at,...parsed<Row>(row.result_json,{}),...(row.failure_reason?{detail:row.failure_reason}:{})};
}
export async function processDiscovery(env:Env,id:string){
  const now=new Date().toISOString();
  await run(env,`UPDATE discovery_runs SET state='failed',failure_reason=CASE WHEN expires_at<=? THEN ? ELSE ? END,finished_at=? WHERE id=? AND state IN ('queued','running') AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM users u WHERE u.id=discovery_runs.user_id AND u.profile_version=discovery_runs.profile_version AND u.mode=discovery_runs.mode))`,now,expiredReason,staleReason,now,id,now);
  const job=await first(env,"UPDATE discovery_runs SET state='running',claimed_at=? WHERE id=? AND state='queued' AND expires_at>? RETURNING *",now,id,now);
  if(!job)return;
  env={...env,OPERATION_CONTEXT:newOperationContext(job.user_id)};
  const warnings:string[]=[],sources:Row[]=[];
  try{
    const discovered=await discoverJobs(env,parsed(job.profile_snapshot,{}),{warn:message=>warnings.push(message),report:rows=>sources.push(...rows),trace:data=>console.log(JSON.stringify({event:'job_discovery',...data}))});
    const valid=discovered.slice(0,10).filter(item=>{try{validatePublicUrl(item.url);}catch{return false;}return ['title','company','description'].every(key=>typeof (item as Row)[key]==='string'&&(item as Row)[key].trim())&&item.title.length<=300&&item.company.length<=300&&item.description.length<=30000&&item.url.length<=2000&&(!item.posted_date||Number.isFinite(Date.parse(item.posted_date)));});
    const live=await first(env,'SELECT state,expires_at FROM discovery_runs WHERE id=?',id);
    if(!live||live.state!=='running'||Date.parse(live.expires_at)<=Date.now())throw new ApiError(409,expiredReason);
    const current=await userById(env,job.user_id);
    if(current.profile_version!==job.profile_version||current.mode!==job.mode)throw new ApiError(409,staleReason);
    const known=await all(env,'SELECT j.url FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=?',job.user_id);
    const identity=(url:string)=>url.replace(/\/apply\/?(?=\?|$)/,'').replace(/\/$/,'');
    const existing=new Set(known.map(item=>identity(item.url))),fresh=valid.filter(item=>!existing.has(identity(item.url)));
    const imported=await addJobs(env,job.user_id,valid,true,{id,profileVersion:job.profile_version});
    const message=imported?`${imported} active opportunities added. Refresh your plan to review the job details and resumes.`:valid.length&&!fresh.length?'These active listings are already in your opportunities. Review your weekly plan or broaden your target role.':valid.length?'Verified listings were already available or ineligible under your current company/mode preferences. Review your plan or broaden the search.':'No new active listings could be verified. Try a broader target role or location, or paste a current job-detail URL and its full description below.';
    const result={imported,discovered:valid.length,already_known:valid.length-fresh.length,not_imported:Math.max(0,fresh.length-imported),sources,warnings,message};
    const finished=new Date().toISOString();
    const saved=await run(env,`UPDATE discovery_runs SET state='completed',result_json=?,finished_at=? WHERE id=? AND state='running' AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=? AND profile_version=? AND mode=?)`,JSON.stringify(result),finished,id,finished,job.user_id,job.profile_version,job.mode);
    if(!saved.meta.changes)await run(env,"UPDATE discovery_runs SET state='failed',failure_reason=CASE WHEN expires_at<=? THEN ? ELSE ? END,finished_at=? WHERE id=? AND state='running'",finished,expiredReason,staleReason,finished,id);
  }catch(error){
    const detail=error instanceof ApiError&&error.status===409?(error.message===expiredReason?expiredReason:staleReason):'Job search could not finish. Please try again, or paste a current job-detail URL and its full description below.';
    await run(env,"UPDATE discovery_runs SET state='failed',failure_reason=?,result_json=?,finished_at=? WHERE id=? AND state='running'",detail,JSON.stringify({sources,warnings}),new Date().toISOString(),id);
  }
}
