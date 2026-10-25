/** Explicit, deduplicated refresh of a stored guide; immutable exports stay intact. */
import {ApiError,type Env,type Row} from './types';
import {all,first,run,userById,applicationQuery,historicalListing} from './storage';
import {buildPrepGuide} from './intelligence';
import {newOperationContext} from './telemetry';
const lifetime=300000,runningLifetime=90000;
const expired='Prep refresh expired before completion. Your saved guide is unchanged; request a refresh to retry.';
const changed='Your profile or listing changed during preparation. The saved guide is unchanged; refresh again when ready.';
const sourceVersion="CASE WHEN a.status IN ('pending','planned') THEN j.facts_version ELSE COALESCE(json_extract(a.job_snapshot,'$.facts_version'),j.facts_version) END";
const safeStatus=(row:Row|null)=>row?{state:row.state,requested_at:row.created_at,...(row.failure_reason?{failure_reason:row.failure_reason}:{})}:null;
async function dispatch(env:Env,row:Row){
 try{await env.APPLICATION_QUEUE.send({kind:'prep',application_id:row.application_id,refresh_token:row.token});await run(env,"UPDATE prep_refreshes SET dispatched_at=? WHERE application_id=? AND token=? AND state='queued'",new Date().toISOString(),row.application_id,row.token);}catch{/* Durable ticket is recovered by maintenance. */}
}
export async function prepRefreshStatus(env:Env,applicationId:number){
 const now=new Date().toISOString();await run(env,"UPDATE prep_refreshes SET state='failed',failure_reason=? WHERE application_id=? AND state IN ('queued','running') AND expires_at<=?",expired,applicationId,now);
 return safeStatus(await first(env,'SELECT state,created_at,failure_reason FROM prep_refreshes WHERE application_id=?',applicationId));
}
export async function startPrepRefresh(env:Env,owner:number,applicationId:number){
 const app=await first(env,`${applicationQuery} WHERE a.id=? AND a.user_id=?`,applicationId,owner);if(!app)throw new ApiError(404,'Application not found');
 const current=await prepRefreshStatus(env,applicationId);if(current&&['queued','running'].includes(current.state))return{application_id:applicationId,...current};
 const now=Date.now(),cutoff=now-600000;
 const allowed=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END WHERE window_start<=? OR attempts<3 RETURNING attempts`,`prep-refresh:${owner}`,now,cutoff,cutoff,cutoff);
 if(!allowed)throw new ApiError(429,'Three preparation refreshes were requested. Wait ten minutes before trying again.');
 const user=await userById(env,owner),job=historicalListing(app),token=crypto.randomUUID(),created=new Date(now).toISOString();
 const row=await first(env,`INSERT INTO prep_refreshes(application_id,token,profile_version,job_version,state,expires_at,created_at)
  SELECT a.id,?,?,?,'queued',?,? FROM applications a JOIN users u ON u.id=a.user_id JOIN jobs j ON j.id=a.job_id
  WHERE a.id=? AND a.user_id=? AND u.profile_version=? AND ${sourceVersion}=?
  ON CONFLICT(application_id) DO UPDATE SET token=excluded.token,profile_version=excluded.profile_version,job_version=excluded.job_version,state='queued',expires_at=excluded.expires_at,created_at=excluded.created_at,dispatched_at=NULL,failure_reason=NULL
  WHERE prep_refreshes.state NOT IN ('queued','running') RETURNING *`,token,user.profile_version,job.facts_version,new Date(now+lifetime).toISOString(),created,applicationId,owner,user.profile_version,job.facts_version);
 if(!row){const active=await first(env,"SELECT * FROM prep_refreshes WHERE application_id=? AND state IN ('queued','running')",applicationId);if(!active)throw new ApiError(409,changed);return{application_id:applicationId,...safeStatus(active),message:'Refresh already requested. Your saved guide remains available until the new version is ready.'};}
 await dispatch(env,row);
 return{application_id:applicationId,...safeStatus(row),message:'Refresh requested. Your saved guide remains available until the new version is ready.'};
}
export async function recoverPrepRefreshes(env:Env){
 const now=new Date().toISOString();await run(env,"UPDATE prep_refreshes SET state='failed',failure_reason=? WHERE state IN ('queued','running') AND expires_at<=?",expired,now);
 const rows=await all(env,"SELECT * FROM prep_refreshes WHERE state='queued' AND dispatched_at IS NULL AND expires_at>? ORDER BY created_at LIMIT 5",now);for(const row of rows)await dispatch(env,row);
 await run(env,"DELETE FROM prep_refreshes WHERE state IN ('completed','failed') AND created_at<?",new Date(Date.now()-7*86400000).toISOString());
}
export async function processPrepRefresh(env:Env,applicationId:number,token:string){
 if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(token))return;
 const now=new Date().toISOString();await run(env,"UPDATE prep_refreshes SET state='failed',failure_reason=? WHERE application_id=? AND token=? AND state IN ('queued','running') AND expires_at<=?",expired,applicationId,token,now);
 const claim=await first(env,"UPDATE prep_refreshes SET state='running',expires_at=? WHERE application_id=? AND token=? AND state='queued' AND expires_at>? RETURNING *",new Date(Date.now()+runningLifetime).toISOString(),applicationId,token,now);if(!claim)return;
 try{
  const app=await first(env,`${applicationQuery} WHERE a.id=?`,applicationId);if(!app)return;
  const user=await userById(env,app.user_id),job=historicalListing(app);
  if(user.profile_version!==claim.profile_version||job.facts_version!==claim.job_version)throw new ApiError(409,changed);
  env={...env,OPERATION_CONTEXT:newOperationContext(app.user_id)};
  const guide=await buildPrepGuide(env,user.master_profile,job),finished=new Date().toISOString();
  const saved=await run(env,`INSERT INTO prep_guides(application_id,structured_data,company_intel,source_profile_version,source_job_version)
   SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM prep_refreshes p JOIN applications a ON a.id=p.application_id JOIN users u ON u.id=a.user_id JOIN jobs j ON j.id=a.job_id
    WHERE p.application_id=? AND p.token=? AND p.state='running' AND p.expires_at>? AND u.profile_version=p.profile_version AND ${sourceVersion}=p.job_version)
   ON CONFLICT(application_id) DO UPDATE SET structured_data=excluded.structured_data,company_intel=excluded.company_intel,source_profile_version=excluded.source_profile_version,source_job_version=excluded.source_job_version`,applicationId,JSON.stringify(guide),JSON.stringify(guide.company_intel||{}),user.profile_version,job.facts_version,applicationId,token,finished);
  if(!saved.meta.changes)throw new ApiError(409,changed);
  await run(env,"UPDATE prep_refreshes SET state='completed',failure_reason=NULL WHERE application_id=? AND token=? AND state='running'",applicationId,token);
 }catch(error){await run(env,"UPDATE prep_refreshes SET state='failed',failure_reason=? WHERE application_id=? AND token=? AND state='running'",error instanceof ApiError&&error.status===409?changed:'Preparation refresh could not finish. Your saved guide is unchanged; retry later.',applicationId,token);}
}
