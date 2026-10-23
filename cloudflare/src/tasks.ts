import { fillApplication } from './automation';
import { buildPrepGuide } from './intelligence';
import { all, first, run, applicationQuery, transition, userById, dispatchOutbox, historicalListing } from './storage';
import { submittedCompanies, companyWasSubmitted } from './company_policy';
import { type Env, type Task, parsed } from './types';
import { files } from './files';
import { checkpointStore, resumableCheckpoint } from './automation_checkpoints';
import { getValidSubmissionReview, validateSubmissionReview } from './reviews';
import { browserDailyBudgetSeconds, submissionDelayMs, newOperationContext, recordOperation } from './telemetry';

export async function processTask(env: Env, message: Message<Task>) {
  const task = message.body;
  if (!task || !Number.isSafeInteger(task.application_id) || !['apply','prep'].includes(task.kind)) { message.ack(); return; }
  const application = await first(env, `${applicationQuery} WHERE a.id=?`, task.application_id);
  if (!application) { message.ack(); return; }
  const started = Date.now(), context = newOperationContext(application.user_id, application.cycle_start || undefined);
  env = { ...env, OPERATION_CONTEXT: context };
  const log = (outcome: 'success'|'degraded'|'failed'|'retry_scheduled'|'limited'|'skipped'|'cancelled', extra: Record<string, any> = {}) => recordOperation(env, { ...context, operation: task.kind === 'apply' ? 'queue_apply' : 'queue_prep', outcome, latency_ms: Date.now()-started, ...extra });
  if (task.kind === 'prep') {
    if (await first(env, 'SELECT id FROM prep_guides WHERE application_id=?', application.id)) { message.ack(); return; }
    try {
      const user = await userById(env, application.user_id);
      const guide = await buildPrepGuide(env, user.master_profile, historicalListing(application));
      await run(env, 'INSERT INTO prep_guides(application_id,structured_data,company_intel) VALUES(?,?,?) ON CONFLICT(application_id) DO NOTHING', application.id, JSON.stringify(guide), JSON.stringify(guide.company_intel || {}));
      await log('success'); message.ack();
    } catch { await log('retry_scheduled',{error_kind:'unavailable',queue_delay_seconds:60}); message.retry({ delaySeconds: 60 }); }
    return;
  }
  // A delayed delivery from an earlier approval must not claim or invalidate a
  // newer confirmation, including a delivery created before review binding.
  if (application.confirmed_review_id && task.review_id !== application.confirmed_review_id) { await log('skipped'); message.ack(); return; }
  // If a previous consumer disappeared, its external click may already have
  // succeeded. Never automatically resubmit an abandoned in-flight application.
  if (application.status === 'applying') {
    if (Date.now() - Date.parse(application.processing_started_at) < 120000) { message.retry({ delaySeconds: 120 }); return; }
    if (task.review_id && await resumableCheckpoint(env, application.id) && await validateSubmissionReview(env, task.review_id, (await first(env,'SELECT binding FROM submission_reviews WHERE id=?',task.review_id))?.binding || '')) {
      await transition(env,application.id,'applying','confirmed','Resuming the last completed pre-submit application step.');
      await log('retry_scheduled',{queue_delay_seconds:1}); message.retry({delaySeconds:1}); return;
    }
    await transition(env, application.id, 'applying', 'needs_action', 'Processing was interrupted. Check the employer site before retrying to avoid duplicate submission.', application.url);
    await schedulePrep(env, application.id); message.ack(); return;
  }
  if (application.status !== 'confirmed') {
    if(['applied','failed','needs_action'].includes(application.status)) await schedulePrep(env,application.id);
    message.ack(); return;
  }
  if (!task.review_id || task.review_id !== application.confirmed_review_id) {
    await transition(env,application.id,'confirmed','needs_action','Review the current resume and application answers before confirming again.',application.url);
    await log('degraded'); await schedulePrep(env,application.id); message.ack(); return;
  }
  if (env.BROWSER_ENABLED !== 'true') {
    await transition(env, application.id, 'confirmed', 'needs_action', 'Browser automation is disabled. Apply manually using the reviewed resume.', application.url);
    await schedulePrep(env, application.id); message.ack(); return;
  }
  // A new immutable KV key may take time to reach a different edge location.
  if(application.expires_at&&Date.parse(application.expires_at)<Date.now()){
    await transition(env,application.id,'confirmed','needs_action','This listing has expired. Check the employer for a current vacancy.',application.url);
    await log('skipped');await schedulePrep(env,application.id);message.ack();return;
  }
  // Wait before acquiring a browser or consuming its daily budget.
  const object=application.resume_path?await files(env).get(application.resume_path):null;
  if(!object){
    const resume=await first(env,'SELECT created_at FROM resumes WHERE application_id=? AND version=? AND object_key=?',application.id,application.resume_version,application.resume_path);
    if(resume&&Date.now()-Date.parse(resume.created_at)<120000){message.retry({delaySeconds:60});return;}
    await transition(env,application.id,'confirmed','failed','Reviewed resume PDF is missing');
    await schedulePrep(env,application.id);message.ack();return;
  }
  const resumeBytes = new Uint8Array(await object.arrayBuffer());
  const user = await userById(env,application.user_id);
  if(companyWasSubmitted(application,await submittedCompanies(env,application.user_id,user.master_profile))){
    await transition(env,application.id,'confirmed','needs_action','A submission or uncertain external write already exists for this company. Check the employer before applying again.',application.url);
    await log('skipped'); await schedulePrep(env,application.id); message.ack(); return;
  }
  const review = await getValidSubmissionReview(env,application,user,resumeBytes);
  if (!review) {
    await transition(env,application.id,'confirmed','needs_action','The reviewed profile, resume, listing or application answers changed or expired. Review again before applying.',application.url);
    await log('degraded'); await schedulePrep(env,application.id); message.ack(); return;
  }
  const resume = await first(env,'SELECT profile_snapshot FROM resumes WHERE application_id=? AND version=? AND object_key=?',application.id,application.resume_version,application.resume_path);
  const reviewedProfile = { ...user.master_profile, ...parsed<Record<string,unknown>>(resume?.profile_snapshot,{}) };
  const now = Date.now(); const day = new Date(now).toISOString().slice(0, 10);
  await run(env, 'INSERT INTO browser_budget(day) VALUES(?) ON CONFLICT(day) DO NOTHING', day);
  const budget = browserDailyBudgetSeconds(env), spacing = submissionDelayMs(env);
  const reserved = await first(env, `UPDATE browser_budget SET reserved_seconds=reserved_seconds+60,last_launch_at=?
    WHERE day=? AND reserved_seconds+60<=? AND last_launch_at<=? RETURNING reserved_seconds`, now, day, budget, now - spacing);
  if (!reserved) {
    const state = await first(env, 'SELECT * FROM browser_budget WHERE day=?', day);
    if ((state?.reserved_seconds || 0) + 60 <= budget) {
      const delay = Math.max(1,Math.ceil((Number(state?.last_launch_at || 0)+spacing-now)/1000)+1);
      await log('retry_scheduled',{error_kind:'queue_backlog',queue_delay_seconds:delay}); message.retry({ delaySeconds: delay }); return;
    }
    await transition(env, application.id, 'confirmed', 'needs_action', 'Daily browser budget reached. Apply manually or wait until the next UTC day.', application.url);
    await log('limited',{error_kind:'budget_exhausted',budget_reserved_seconds:Number(state?.reserved_seconds || 0)});
    await schedulePrep(env, application.id); message.ack(); return;
  }
  const claimed = await run(env, `UPDATE applications SET status='applying',attempts=attempts+1,processing_started_at=?,failure_reason=NULL
    WHERE id=? AND status='confirmed' AND confirmed_review_id=? AND resume_path=? AND resume_version=?
    AND EXISTS(SELECT 1 FROM users WHERE id=applications.user_id AND profile_version=?)
    AND EXISTS(SELECT 1 FROM jobs WHERE id=applications.job_id AND url=? AND description=? AND title=? AND company=?)
    AND EXISTS(SELECT 1 FROM submission_reviews WHERE id=? AND binding=? AND revoked_at IS NULL AND approved_at IS NOT NULL AND expires_at>?)`,
    new Date(now).toISOString(),application.id,review.reviewId,application.resume_path,application.resume_version,user.profile_version,
    application.url,application.description,application.title,application.company,review.reviewId,review.binding,new Date(now).toISOString());
  if (!claimed.meta.changes) {
    await run(env,'UPDATE browser_budget SET reserved_seconds=MAX(0,reserved_seconds-60) WHERE day=?',day);
    await log('cancelled',{error_kind:'cancelled'}); message.ack(); return;
  }
  try {
    {
      const result = await fillApplication({ applicationUrl: application.url, profile: reviewedProfile,
        resume: resumeBytes, resumeName: `${application.job_id}_resume_v${application.resume_version}.pdf`, jdText: application.description,
        approvedAnswers: review.answers, reviewBinding: review.binding,
        beforeFinalSubmit: () => validateSubmissionReview(env,review.reviewId,review.binding),
        checkpoints: checkpointStore(env,application.id,review.reviewId,review.binding),
      }, env);
      if (result.retryable && !result.submitted && application.attempts + 1 < 3) {
        await transition(env, application.id, 'applying', 'confirmed', result.reason || 'Temporary network failure; retry scheduled');
        await log('retry_scheduled',{error_kind:'unavailable',attempt:application.attempts+1,queue_delay_seconds:40*2**application.attempts});
        message.retry({ delaySeconds: 40 * 2 ** application.attempts });
        return;
      }
      await transition(env, application.id, 'applying', result.status, result.reason, result.status === 'needs_action' ? result.manual_action_url || application.url : null);
      await log(result.status === 'applied' ? 'success' : result.status === 'needs_action' ? 'degraded' : 'failed',{attempt:application.attempts+1,budget_reserved_seconds:60});
    }
  } catch {
    // Do not log provider credentials or an exception with applicant data.
    await transition(env, application.id, 'applying', 'needs_action', 'Processing was interrupted. Check the employer site before attempting another submission.', application.url);
  }
  await schedulePrep(env, application.id);
  message.ack();
}
async function schedulePrep(env: Env, id: number) {
  await run(env, "INSERT INTO outbox(application_id,kind) VALUES(?,'prep') ON CONFLICT(application_id,kind) DO NOTHING", id);
  await dispatchOutbox(env);
}
export async function scheduledRecovery(env: Env) {
  await run(env, 'DELETE FROM sessions WHERE expires_at<?', new Date().toISOString());
  await run(env, 'DELETE FROM session_transfers WHERE expires_at<?', new Date().toISOString());
  await run(env, 'DELETE FROM login_attempts WHERE window_start<?', Date.now() - 86400000);
  await run(env,'DELETE FROM browser_budget WHERE day<?',new Date(Date.now()-30*86400000).toISOString().slice(0,10));
  await run(env,"DELETE FROM automation_checkpoints WHERE expires_at<? AND phase='ready'",new Date().toISOString());
  // Expire sensitive browser state while preserving the small no-replay marker.
  await run(env,"UPDATE automation_checkpoints SET encrypted_state='' WHERE expires_at<? AND phase IN ('advancing','submitting','submitted','uncertain')",new Date().toISOString());
  const abandoned = await all(env, "SELECT applications.id,applications.confirmed_review_id,jobs.url FROM applications JOIN jobs ON jobs.id=applications.job_id WHERE applications.status='applying' AND processing_started_at<? LIMIT 10", new Date(Date.now() - 5 * 60000).toISOString());
  for (const app of abandoned) {
    const review = app.confirmed_review_id && await first(env,'SELECT binding FROM submission_reviews WHERE id=?',app.confirmed_review_id);
    if (review && await resumableCheckpoint(env,app.id) && await validateSubmissionReview(env,app.confirmed_review_id,review.binding)) {
      await transition(env,app.id,'applying','confirmed','Resuming the last completed pre-submit application step.');
      await run(env,"INSERT INTO outbox(application_id,kind,review_id) VALUES(?,'apply',?) ON CONFLICT(application_id,kind) DO UPDATE SET dispatched_at=NULL,review_id=excluded.review_id",app.id,app.confirmed_review_id);
      continue;
    }
    await transition(env, app.id, 'applying', 'needs_action', 'Processing was interrupted. Check the employer site before retrying.', app.url);
    await run(env, "INSERT INTO outbox(application_id,kind) VALUES(?,'prep') ON CONFLICT(application_id,kind) DO NOTHING", app.id);
  }
  // Recreate queue deliveries if messages expired while a free-tier queue was
  // paused (24-hour retention). Atomic claims make old duplicates harmless.
  await run(env, `UPDATE outbox SET dispatched_at=NULL WHERE kind='apply' AND dispatched_at<? AND application_id IN (SELECT id FROM applications WHERE status='confirmed')`, new Date(Date.now() - 3600000).toISOString());
  await run(env, `UPDATE outbox SET dispatched_at=NULL WHERE kind='prep' AND dispatched_at<? AND application_id NOT IN (SELECT application_id FROM prep_guides)`, new Date(Date.now() - 3600000).toISOString());
  await run(env,`INSERT INTO outbox(application_id,kind) SELECT id,'prep' FROM applications WHERE status IN ('applied','failed','needs_action') AND id NOT IN (SELECT application_id FROM prep_guides) LIMIT 10 ON CONFLICT(application_id,kind) DO NOTHING`);
  await dispatchOutbox(env);
}
