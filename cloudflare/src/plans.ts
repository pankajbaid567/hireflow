import { ApiError, type Env, type Row, parsed, weekStart } from './types';
import { all, first, run, userById, applicationQuery, dispatchOutbox } from './storage';
import { scoreMatch } from './intelligence';
import { createResume } from './pdf';
import { validatePublicUrl } from './automation';
import { files } from './files';
import { hasTailoringProvider, tailorResume } from './resume_tailoring';
import { getValidSubmissionReview } from './reviews';

function sourceName(raw: string): string {
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, '');
    for (const [domain, label] of [
      ['internshala.com', 'Internshala'], ['wellfound.com', 'Wellfound'],
      ['linkedin.com', 'LinkedIn'], ['naukri.com', 'Naukri'],
      ['greenhouse.io', 'Greenhouse'], ['lever.co', 'Lever'],
      ['ashbyhq.com', 'Ashby'], ['indeed.com', 'Indeed'],
    ]) if (host === domain || host.endsWith(`.${domain}`)) return label;
    return host;
  } catch { return ''; }
}

export function eligible(row: Row, user: Row) {
  const blocked = user.master_profile?.blacklist_companies || [];
  return !row.is_spam && row.listing_type === user.mode &&
    !(Array.isArray(blocked) ? blocked : [blocked]).some((name: any) => String(name).toLowerCase() === String(row.company).toLowerCase()) &&
    (!row.posted_date || Date.parse(row.posted_date) >= Date.now() - 30 * 86400000);
}
export async function addJobs(env: Env, userId: number, incoming: Row[]) {
  const user = await userById(env, userId);
  const jobs = incoming.slice(0, 20).map(raw => {
    for (const key of ['title', 'company', 'url', 'description']) if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new ApiError(422, `Job ${key} is required`);
    if (raw.description.length > 30000 || raw.title.length > 300 || raw.company.length > 300 || raw.url.length > 2000) throw new ApiError(422, 'Job data is too large');
    let url: string;
    try { url = validatePublicUrl(raw.url); } catch { throw new ApiError(422, 'Use a public HTTP(S) application URL'); }
    const listingType = raw.listing_type || user.mode;
    if (!['job', 'internship'].includes(listingType)) throw new ApiError(422, 'Invalid listing type');
    const posted = raw.posted_date ? new Date(raw.posted_date) : null;
    if (posted && !Number.isFinite(posted.getTime())) throw new ApiError(422, 'Invalid posting date');
    return { title: raw.title.trim(), company: raw.company.trim(), url, description: raw.description, location: String(raw.location || '').slice(0, 300), listing_type: listingType, posted_date: posted?.toISOString() || null };
  });
  if (!jobs.length) return 0;
  await run(env, `INSERT INTO jobs(title,company,url,description,location,listing_type,posted_date)
    SELECT json_extract(value,'$.title'),json_extract(value,'$.company'),json_extract(value,'$.url'),json_extract(value,'$.description'),json_extract(value,'$.location'),json_extract(value,'$.listing_type'),json_extract(value,'$.posted_date') FROM json_each(?) WHERE 1 ON CONFLICT(url) DO NOTHING`, JSON.stringify(jobs));
  const rows = await all(env, 'SELECT * FROM jobs WHERE url IN (SELECT json_extract(value,\'$.url\') FROM json_each(?))', JSON.stringify(jobs));
  const scored = rows.filter(job => eligible(job, user)).map(job => {
    const score = scoreMatch(user.master_profile, job as any);
    return { job_id: job.id, score: score.score, gaps: JSON.stringify(score.gaps),matched:JSON.stringify(score.matched) };
  });
  await run(env, `INSERT INTO applications(user_id,job_id,match_score,skill_gaps,matched_skills,scored_profile_version)
    SELECT ?,json_extract(value,'$.job_id'),json_extract(value,'$.score'),json_extract(value,'$.gaps'),json_extract(value,'$.matched'),? FROM json_each(?) WHERE 1 ON CONFLICT(user_id,job_id) DO NOTHING`, userId,user.profile_version, JSON.stringify(scored));
  return scored.length;
}

// Plan selection and quota check happen inside single atomic D1 statements,
// avoiding profile/confirmation races without holding locks across R2 calls.
export async function getPlan(env: Env, userId: number) {
  const user = await userById(env, userId); const start = weekStart();
  // Re-score five drafts at a time after profile edits. Never scan hundreds of
  // full JDs in a request with the Workers Free 10 ms CPU allowance.
  const stale = await all(env,`${applicationQuery} WHERE a.user_id=? AND a.status IN ('pending','planned') AND a.scored_profile_version<>? ORDER BY a.id LIMIT 5`,userId,user.profile_version);
  if(stale.length){
    const scores=stale.map(row=>{const score=scoreMatch(user.master_profile,row as any);return{id:row.id,score:score.score,gaps:JSON.stringify(score.gaps),matched:JSON.stringify(score.matched)};});
    await run(env,`UPDATE applications SET match_score=(SELECT json_extract(value,'$.score') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id),
      skill_gaps=(SELECT json_extract(value,'$.gaps') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id),matched_skills=(SELECT json_extract(value,'$.matched') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id),scored_profile_version=?
      WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?)) AND (SELECT profile_version FROM users WHERE id=?)=?`,JSON.stringify(scores),JSON.stringify(scores),JSON.stringify(scores),user.profile_version,userId,JSON.stringify(scores),userId,user.profile_version);
    const pending=await first(env,"SELECT count(*) AS n FROM applications WHERE user_id=? AND status IN ('pending','planned') AND scored_profile_version<>?",userId,user.profile_version);
    if(pending!.n)return {user_id:userId,quota:user.weekly_quota,confirmation_mode:user.confirmation_mode,plan:[],alternatives:[],preparing:true,warnings:[`Updating matches for ${pending!.n} remaining listings. The plan refreshes automatically.`]};
  }
  const planQuery=`SELECT a.*,j.title,j.company,j.url,j.location,j.listing_type,j.is_spam,j.posted_date,
    (SELECT r.tailoring_metadata FROM resumes r WHERE r.application_id=a.id AND r.version=a.resume_version) AS tailoring_metadata,
    (SELECT sr.id FROM submission_reviews sr WHERE sr.application_id=a.id AND sr.profile_version=(SELECT profile_version FROM users WHERE id=a.user_id)
      AND sr.resume_version=a.resume_version AND sr.resume_path=a.resume_path AND sr.approved_at IS NOT NULL AND sr.revoked_at IS NULL
      AND sr.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY sr.created_at DESC LIMIT 1) AS review_id
    FROM applications a JOIN jobs j ON j.id=a.job_id`;
  const rows = await all(env, `${planQuery} WHERE a.user_id=? AND a.status IN ('pending','planned') ORDER BY a.match_score DESC,a.id LIMIT 200`, userId);
  const candidates: Row[] = rows.filter(row => eligible(row, user));
  const consumed = await first(env, "SELECT count(*) AS n FROM applications WHERE user_id=? AND cycle_start=? AND status NOT IN ('pending','planned')", userId, start);
  const remaining = Math.max(0, user.weekly_quota - consumed!.n);
  // Preserve swaps, then fill vacant places by rank.
  const keep = [...candidates.filter(a => a.status === 'planned'), ...candidates.filter(a => a.status === 'pending')].slice(0, remaining);
  await env.DB.batch([
    env.DB.prepare(`UPDATE applications SET status='pending',cycle_start=NULL,failure_reason='Removed from the current weekly plan'
      WHERE user_id=? AND status='planned' AND id NOT IN (SELECT value FROM json_each(?))`).bind(userId, JSON.stringify(keep.map(a => a.id))),
    env.DB.prepare(`UPDATE applications SET status='planned',cycle_start=?,failure_reason=NULL WHERE id IN (
      SELECT a.id FROM applications a WHERE a.user_id=? AND a.status IN ('pending','planned') AND a.id IN (SELECT value FROM json_each(?))
      ORDER BY a.match_score DESC,a.id LIMIT MAX(0,(SELECT weekly_quota FROM users WHERE id=?)-(SELECT count(*) FROM applications WHERE user_id=? AND cycle_start=? AND status NOT IN ('pending','planned'))))`).bind(start, userId, JSON.stringify(keep.map(a => a.id)), userId, userId, start),
  ]);
  const planned = await all(env, `${planQuery} WHERE a.user_id=? AND a.status='planned' ORDER BY a.match_score DESC,a.id`, userId);
  // One provider-backed draft per invocation keeps requests within the proxy
  // deadline; offline runs still prepare three. Leases prevent duplicate model
  // calls while another poll is preparing the same profile/application.
  const limit = hasTailoringProvider(env) ? 1 : 3; let generated = 0;
  for (const application of planned) {
    if (!application.resume_path && generated < limit) {
      const token = crypto.randomUUID(), now = new Date().toISOString();
      const lease = await first(env, `INSERT INTO resume_preparations(application_id,profile_version,token,expires_at)
        SELECT id,?, ?,? FROM applications WHERE id=? AND status='planned' AND resume_path IS NULL
          AND (SELECT profile_version FROM users WHERE id=?)=?
        ON CONFLICT(application_id) DO UPDATE SET profile_version=excluded.profile_version,token=excluded.token,expires_at=excluded.expires_at
          WHERE resume_preparations.expires_at<=? OR resume_preparations.profile_version<>excluded.profile_version RETURNING token`,
      user.profile_version,token,new Date(Date.now()+90000).toISOString(),application.id,userId,user.profile_version,now);
      if (!lease) continue;
      try {
        const reserved = await first(env, `UPDATE applications SET resume_version=resume_version+1 WHERE id=? AND status='planned' AND resume_path IS NULL
          AND (SELECT profile_version FROM users WHERE id=?)=? AND EXISTS(SELECT 1 FROM resume_preparations WHERE application_id=? AND token=?) RETURNING resume_version`,application.id,userId,user.profile_version,application.id,token);
        if(!reserved) continue;
        const version = reserved.resume_version;
        const key = `resumes/${userId}/${application.job_id}_resume_v${version}.pdf`;
        // Load a full JD only for this bounded generation, never all 200 cards.
        const job = await first(env,'SELECT description FROM jobs WHERE id=?',application.job_id);
        const tailored = await tailorResume(env,user.master_profile,{...application,description:job?.description || ''},parsed(application.matched_skills,[]));
        const bytes = createResume(tailored.profile, application, parsed(application.matched_skills,[]));
        await files(env).put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
        const metadata=JSON.stringify({...tailored.metadata,profile_version:user.profile_version});
        // A profile edit, swap, expired lease or competing version must not attach
        // a stale summary/PDF. The reviewed immutable version carries provenance.
        const saved=await env.DB.batch([
          env.DB.prepare(`INSERT INTO resumes(application_id,version,object_key,tailoring_metadata,profile_snapshot)
            SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications a JOIN resume_preparations p ON p.application_id=a.id
              WHERE a.id=? AND a.status='planned' AND a.resume_version=? AND a.resume_path IS NULL AND p.token=? AND p.expires_at>?
                AND (SELECT profile_version FROM users WHERE id=?)=?) ON CONFLICT(application_id,version) DO NOTHING RETURNING id`).bind(application.id,version,key,metadata,JSON.stringify(tailored.profile),application.id,version,token,new Date().toISOString(),userId,user.profile_version),
          env.DB.prepare(`UPDATE applications SET resume_path=? WHERE id=? AND resume_version=? AND status='planned' AND resume_path IS NULL
            AND (SELECT profile_version FROM users WHERE id=?)=? AND EXISTS(SELECT 1 FROM resumes WHERE application_id=? AND version=? AND object_key=?)
            AND EXISTS(SELECT 1 FROM resume_preparations WHERE application_id=? AND token=?) RETURNING id`).bind(key,application.id,version,userId,user.profile_version,application.id,version,key,application.id,token),
        ]);
        if(!saved[1].results.length) await files(env).delete(key);
        generated++;
      } catch { throw new ApiError(503,'Resume preparation could not finish. Please refresh your plan and review your profile.'); }
      finally { await run(env,'DELETE FROM resume_preparations WHERE application_id=? AND token=?',application.id,token); }
    }
  }
  const finalPlanned = await all(env,`${planQuery} WHERE a.user_id=? AND a.status='planned' ORDER BY a.match_score DESC,a.id`,userId);
  const alternatives = candidates.filter(a => !finalPlanned.some(p => p.id === a.id)).slice(0, 40);
  const item = (a: Row) => {const metadata=parsed<Row>(a.tailoring_metadata,{});return ({ application_id: a.id, job_id: a.job_id, role_title: a.title, company_name: a.company,
    url:a.url,source:sourceName(a.url),location:a.location || '',listing_type:a.listing_type,
    match_score: a.match_score, skill_gaps: parsed(a.skill_gaps, []), resume_version: a.resume_version,
    resume_url: a.resume_path ? `/resumes/${userId}/${a.id}/download` : null,
    review_id: a.review_id || null, resume_rejected: a.resume_rejected_version === a.resume_version,
    resume_summary: a.resume_path ? metadata.summary || 'Review your resume before confirming.' : 'Refresh the plan to prepare this resume.',
    resume_tailoring:a.resume_path && metadata.method ? metadata : null });};
  const warnings=[...new Set(finalPlanned.flatMap(a=>parsed<Row>(a.tailoring_metadata,{}).warnings || []))];
  if(finalPlanned.some(a=>!a.resume_path))warnings.push('Preparing the remaining resumes. The plan refreshes automatically.');
  return { user_id: userId, quota: user.weekly_quota, confirmation_mode: user.confirmation_mode, review_required:true, plan: finalPlanned.map(item), alternatives: alternatives.map(item),
    preparing:finalPlanned.some(a=>!a.resume_path),warnings };
}

export async function swapPlan(env: Env, userId: number, remove: number, add: number) {
  const user = await userById(env, userId); const start = weekStart();
  const removeRow = await first(env, "SELECT id FROM applications WHERE user_id=? AND job_id=? AND status='planned' AND cycle_start=?", userId, remove, start);
  const addRow = await first(env, `${applicationQuery} WHERE a.user_id=? AND a.job_id=? AND a.status='pending'`, userId, add);
  if (!removeRow || !addRow || !eligible(addRow, user)) throw new ApiError(400, 'Select a currently planned job and an eligible alternative');
  // One UPDATE gives both rows the same snapshot, so a concurrent confirm cannot
  // partially remove or add a draft.
  const result = await run(env, `UPDATE applications SET status=CASE WHEN id=? THEN 'pending' ELSE 'planned' END,
    cycle_start=CASE WHEN id=? THEN NULL ELSE ? END,failure_reason=NULL
    WHERE id IN (?,?) AND (SELECT count(*) FROM applications WHERE (id=? AND status='planned' AND cycle_start=?) OR (id=? AND status='pending'))=2 RETURNING id`,
  removeRow.id, removeRow.id, start, removeRow.id, addRow.id, removeRow.id, start, addRow.id);
  if (result.results.length !== 2) throw new ApiError(409, 'Plan changed. Refresh before swapping');
  return getPlan(env, userId);
}

export async function confirmPlan(env: Env, userId: number, ids: number[], reviewIds?: string[]) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id))) throw new ApiError(400, 'Select distinct planned job IDs');
  const user = await userById(env, userId); const start = weekStart();
  const rows = await all(env, `${applicationQuery} WHERE a.user_id=? AND a.job_id IN (SELECT value FROM json_each(?))`, userId, JSON.stringify(ids));
  if((env.GEMINI_API_KEY || env.GOOGLE_API_KEY) && user.master_profile.resume_extraction_warning)
    throw new ApiError(409,'Your uploaded resume has not been fully read. Open your profile and upload it again before confirming applications.');
  if (rows.length !== ids.length || rows.some(row => row.status !== 'planned' || row.cycle_start !== start || !eligible(row, user) || !row.resume_path)) throw new ApiError(400, 'Refresh your plan and review the prepared resumes before confirming');
  if (!Array.isArray(reviewIds) || reviewIds.length!==ids.length || new Set(reviewIds).size!==reviewIds.length || reviewIds.some(id=>typeof id!=='string'||id.length>100))
    throw new ApiError(409,'Review each selected PDF and its answers before confirming.');
  const reviews=await all(env,'SELECT id,application_id FROM submission_reviews WHERE user_id=? AND id IN (SELECT value FROM json_each(?))',userId,JSON.stringify(reviewIds));
  const sources=[];
  for(const row of rows){
    const review=reviews.find(review=>review.application_id===row.id);
    if(!review || row.resume_rejected_version===row.resume_version)throw new ApiError(409,'A selected resume or answer review is missing or rejected. Review it again.');
    const valid=await getValidSubmissionReview(env,{...row,confirmed_review_id:review.id},user);
    if(!valid)throw new ApiError(409,'Your profile, listing, PDF or answers changed. Review the current version again.');
    sources.push({id:row.id,resume:row.resume_path,review_id:review.id,binding:valid.binding});
  }
  const keys = JSON.stringify(sources), now=new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE applications SET status='confirmed',failure_reason=NULL,updated_at=?,confirmed_review_id=(SELECT json_extract(value,'$.review_id') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id)
      WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
      AND (SELECT count(*) FROM applications a JOIN json_each(?) k ON a.id=json_extract(k.value,'$.id') JOIN submission_reviews sr ON sr.id=json_extract(k.value,'$.review_id')
        WHERE a.status='planned' AND a.cycle_start=? AND a.resume_path=json_extract(k.value,'$.resume') AND a.resume_rejected_version<>a.resume_version
          AND sr.application_id=a.id AND sr.user_id=a.user_id AND sr.resume_version=a.resume_version AND sr.profile_version=?
          AND sr.revoked_at IS NULL AND sr.approved_at IS NOT NULL AND sr.expires_at>? AND sr.binding=json_extract(k.value,'$.binding'))=?
      AND (SELECT count(*) FROM applications WHERE user_id=? AND cycle_start=? AND status NOT IN ('pending','planned'))+? <= (SELECT weekly_quota FROM users WHERE id=?)
      AND (SELECT profile_version FROM users WHERE id=?)=? RETURNING id`).bind(now,keys,userId,keys,keys,start,user.profile_version,now,ids.length,userId,start,ids.length,userId,userId,user.profile_version),
    env.DB.prepare(`INSERT INTO outbox(application_id,kind,review_id) SELECT id,'apply',confirmed_review_id FROM applications WHERE user_id=? AND status='confirmed' AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
      ON CONFLICT(application_id,kind) DO UPDATE SET review_id=excluded.review_id,dispatched_at=NULL WHERE outbox.review_id IS NOT excluded.review_id`).bind(userId, keys),
  ]);
  if (results[0].results.length !== ids.length) throw new ApiError(409, 'Plan or quota changed. Refresh before confirming');
  await dispatchOutbox(env);
  return { status: 'success', message: `${ids.length} applications confirmed and queued. Browser limits may require manual action.`, confirmed_job_ids: ids };
}
