/** Durable, owner-scoped preparation. This work never grants submission approval. */
import {ApiError,type Env,type Row,weekStart} from './types';
import {all,first,run,userById,applicationQuery} from './storage';
import {files} from './files';
import {ResumeFormatError} from './pdf';
import {runPlanResumeWork,runPlanScoreWork} from './plans';
import {newOperationContext} from './telemetry';

const queuedLifetime=5*60_000,runningLifetime=90_000,maxClaims=2;
const interrupted='Plan preparation was interrupted twice. Use Refresh matching or regenerate the resume to retry; existing downloads are preserved.';
const failed='Plan preparation could not finish. Review your profile, then use Refresh matching or regenerate the resume to retry.';
type WorkKind='score'|'resume';
type WorkResult={state:'queued'|'failed';reason?:string};
const snapshotSql=`SELECT p.*,a.user_id,a.status,a.cycle_start,a.job_id,a.resume_path,j.facts_version AS current_job_version,j.listing_type,
 u.profile_version AS current_profile_version,u.mode,u.weekly_quota,
 (SELECT count(*) FROM applications used WHERE used.user_id=a.user_id AND used.cycle_start=? AND used.status NOT IN ('pending','planned')) AS consumed
 FROM resume_preparations p JOIN applications a ON a.id=p.application_id JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.user_id`;
function current(row:Row){
  return row.profile_version===row.current_profile_version&&row.job_version===row.current_job_version&&row.listing_type===row.mode&&row.consumed<row.weekly_quota&&
    (row.kind==='score'?['pending','planned'].includes(row.status):row.kind==='resume'&&row.status==='planned'&&row.cycle_start===weekStart()&&!row.resume_path);
}
async function cleanupObject(env:Env,row:Row){
  if(!row.object_key)return;
  // An immutable registered version remains a valid historical download even
  // when the profile, current plan or resume selection subsequently changes.
  const registered=await first(env,'SELECT id FROM resumes WHERE object_key=? UNION ALL SELECT id FROM applications WHERE resume_path=? LIMIT 1',row.object_key,row.object_key);
  if(!registered)await files(env).delete(row.object_key);
  await run(env,'UPDATE resume_preparations SET object_key=NULL WHERE application_id=? AND token=? AND object_key=?',row.application_id,row.token,row.object_key);
}
async function dispatch(env:Env,row:Row){
  try{
    await env.APPLICATION_QUEUE.send({kind:'plan',application_id:row.application_id,token:row.token});
    await run(env,"UPDATE resume_preparations SET dispatched_at=? WHERE application_id=? AND token=? AND state='queued'",new Date().toISOString(),row.application_id,row.token);
  }catch{/* A durable undispatched lease is retried by maintenance or the next poll. */}
}
export async function enqueuePlanWork(env:Env,user:Row,application:Row,kind:WorkKind):Promise<WorkResult>{
  let row=await first(env,'SELECT * FROM resume_preparations WHERE application_id=?',application.id);
  if(row){
    const same=row.profile_version===user.profile_version&&row.job_version===application.facts_version&&row.kind===kind;
    if(row.state==='failed'&&same)return{state:'failed',reason:row.failure_reason||failed};
    // A stale failed row may retain a put interrupted before attachment. Ask the
    // consumer to clean its old token before a new version can reserve work.
    if(row.state==='failed'&&!same){
      await run(env,"UPDATE resume_preparations SET state='queued',dispatched_at=NULL,expires_at=? WHERE application_id=? AND token=? AND state='failed'",new Date(Date.now()+queuedLifetime).toISOString(),application.id,row.token);
      row={...row,state:'queued',dispatched_at:null};
    }
    if(row.state==='queued'&&!row.dispatched_at)await dispatch(env,row);
    return{state:'queued'};
  }
  const now=new Date().toISOString(),token=crypto.randomUUID();
  row=await first(env,`INSERT INTO resume_preparations(application_id,profile_version,job_version,kind,state,token,expires_at)
    SELECT a.id,?,?,?,'queued',?,? FROM applications a JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND u.profile_version=? AND j.facts_version=? AND j.listing_type=u.mode
      AND a.status IN ('pending','planned') AND (?='score' OR (a.status='planned' AND a.resume_path IS NULL AND a.cycle_start=?))
      AND (SELECT count(*) FROM applications used WHERE used.user_id=a.user_id AND used.cycle_start=? AND used.status NOT IN ('pending','planned'))<u.weekly_quota
      AND NOT EXISTS(SELECT 1 FROM resume_preparations active JOIN applications other ON other.id=active.application_id WHERE other.user_id=a.user_id AND active.state IN ('queued','running','recovering') AND active.expires_at>?)
    ON CONFLICT(application_id) DO NOTHING RETURNING *`,user.profile_version,application.facts_version,kind,token,new Date(Date.now()+queuedLifetime).toISOString(),application.id,user.id,user.profile_version,application.facts_version,kind,weekStart(),weekStart(),now);
  if(row)await dispatch(env,row);
  return{state:'queued'};
}
async function recoverRow(env:Env,row:Row){
  // Revoke the old generation before touching its object. An in-flight worker
  // must never inherit a renewed lease or clean a newer consumer's object.
  const token=crypto.randomUUID(),now=new Date().toISOString();
  const rotated=await first(env,`UPDATE resume_preparations SET token=?,state='recovering',expires_at=?,
    attempts=attempts+CASE WHEN state='running' THEN 0 ELSE 1 END
    WHERE application_id=? AND token=? AND state IN ('queued','running','recovering') AND expires_at<=? RETURNING *`,token,new Date(Date.now()+runningLifetime).toISOString(),row.application_id,row.token,now);
  if(!rotated)return;
  const currentRow=await first(env,`${snapshotSql} WHERE p.application_id=? AND p.token=?`,weekStart(),row.application_id,token);
  if(!currentRow)return;
  await cleanupObject(env,currentRow);
  if(!current(currentRow)){
    await run(env,'DELETE FROM resume_preparations WHERE application_id=? AND token=?',row.application_id,token);
    return;
  }
  if(rotated.attempts>=maxClaims){
    await run(env,"UPDATE resume_preparations SET state='failed',failure_reason=?,object_key=NULL WHERE application_id=? AND token=? AND state='recovering'",interrupted,row.application_id,token);
    return;
  }
  const queued=await first(env,"UPDATE resume_preparations SET state='queued',dispatched_at=NULL,expires_at=?,object_key=NULL WHERE application_id=? AND token=? AND state='recovering' RETURNING *",new Date(Date.now()+queuedLifetime).toISOString(),row.application_id,token);
  if(queued)await dispatch(env,queued);
}
export async function recoverPlanWork(env:Env){
  if(env.PLAN_WORK_IN_QUEUE!=='true')return;
  const now=new Date().toISOString();
  // Bounded recovery keeps one maintenance message below its CPU allowance.
  const expired=await all(env,`${snapshotSql} WHERE p.state IN ('queued','running','recovering') AND p.expires_at<=? ORDER BY p.expires_at LIMIT 5`,weekStart(),now);
  for(const row of expired)await recoverRow(env,row);
  const failedObjects=await all(env,"SELECT * FROM resume_preparations WHERE state='failed' AND object_key IS NOT NULL LIMIT 5");
  for(const row of failedObjects)await cleanupObject(env,row);
  const queued=await all(env,"SELECT * FROM resume_preparations WHERE state='queued' AND dispatched_at IS NULL AND expires_at>? ORDER BY expires_at LIMIT 5",now);
  for(const row of queued)await dispatch(env,row);
}
export async function processPlanTask(env:Env,applicationId:number,token:string){
  if(env.PLAN_WORK_IN_QUEUE!=='true')return;
  let row=await first(env,`${snapshotSql} WHERE p.application_id=? AND p.token=?`,weekStart(),applicationId,token);
  if(!row)return;
  // Duplicate delivery cannot invalidate a live claim while that consumer is
  // normalizing the captured listing or writing its immutable object.
  if(row.state==='running'&&Date.parse(row.expires_at)>Date.now())return;
  if(!current(row)){
    await cleanupObject(env,row);
    await run(env,'DELETE FROM resume_preparations WHERE application_id=? AND token=?',applicationId,token);
    return;
  }
  if(['queued','running','recovering'].includes(row.state)&&Date.parse(row.expires_at)<=Date.now()){
    await recoverRow(env,row);
    row=await first(env,`${snapshotSql} WHERE p.application_id=? AND p.token=?`,weekStart(),applicationId,token);
    if(!row)return;
  }
  if(row.state==='failed'){await cleanupObject(env,row);return;}
  const claim=await first(env,"UPDATE resume_preparations SET state='running',attempts=attempts+1,expires_at=? WHERE application_id=? AND token=? AND state='queued' AND attempts<? AND expires_at>? RETURNING *",new Date(Date.now()+runningLifetime).toISOString(),applicationId,token,maxClaims,new Date().toISOString());
  if(!claim)return;
  env={...env,OPERATION_CONTEXT:newOperationContext(row.user_id)};
  try{
    const user=await userById(env,row.user_id);
    const application=await first(env,`${applicationQuery} WHERE a.id=? AND a.user_id=?`,applicationId,row.user_id);
    if(!application||user.profile_version!==claim.profile_version||application.facts_version!==claim.job_version||application.listing_type!==user.mode)return;
    if(claim.kind==='score')await runPlanScoreWork(env,user,[application],token);
    else await runPlanResumeWork(env,user,application,token,true);
  }catch(error){
    // Never copy provider exceptions, prompts or raw profile data into a ticket.
    const reason=error instanceof ResumeFormatError||(error instanceof ApiError&&error.status===422)?error.message:failed;
    await run(env,"UPDATE resume_preparations SET state='failed',failure_reason=? WHERE application_id=? AND token=? AND state='running'",reason,applicationId,token);
  }finally{
    const latest=await first(env,'SELECT * FROM resume_preparations WHERE application_id=? AND token=?',applicationId,token);
    if(latest)await cleanupObject(env,latest);
    await run(env,"DELETE FROM resume_preparations WHERE application_id=? AND token=? AND state='running'",applicationId,token);
  }
}
