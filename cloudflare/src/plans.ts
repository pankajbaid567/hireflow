import { ApiError, type Env, type Row, parsed, weekStart } from './types';
import { all, first, run, userById, applicationQuery, dispatchOutbox, listingSnapshot } from './storage';
import { scoreMatch, extractSkills } from './intelligence';
import { LISTING_SCHEMA_VERSION, canonicalListingUrl, companyAliases, companyKey, enrichListing, sourceName } from './listing_details';
import { companyWasSubmitted, submittedCompanies } from './company_policy';
import { MATCHING_ALGORITHM, rankWithSemantic } from './semantic_matching';
import { createResume, ResumeFormatError } from './pdf';
import { validatePublicUrl } from './automation';
import { files } from './files';
import { hasTailoringProvider, tailorResume } from './resume_tailoring';
import { getValidSubmissionReview } from './reviews';

export function eligible(row: Row, user: Row, submitted = new Set<string>()) {
  const blocked = user.master_profile?.blacklist_companies || [];
  return !row.is_spam && row.listing_type === user.mode &&
    !(Array.isArray(blocked) ? blocked : [blocked]).some((name: any) => companyKey(String(name)) === companyKey(String(row.company))) &&
    !companyWasSubmitted(row,submitted) && (!row.expires_at || Date.parse(row.expires_at)>=Date.now()) &&
    (!row.posted_date || Date.parse(row.posted_date) >= Date.now() - 30 * 86400000);
}
const factsColumns=['canonical_url','application_url','source','required_skills','required_experience','expires_at','selection_process','compensation','provenance','company_key','spam_confidence','quality_reason','quality_method','is_spam'] as const;
const jsonFields=new Set(['required_skills','required_experience','selection_process','compensation','provenance']);
function factsValues(job:Row){return factsColumns.map(key=>jsonFields.has(key)?JSON.stringify(job[key]??null):key==='is_spam'?Number(Boolean(job[key])):job[key]??null);}
async function scoredJobs(env:Env,user:Row,rows:Row[]):Promise<Row[]>{
  const profile={...user.master_profile,mode:user.mode};
  const jobs=rows.map(job=>{const score=scoreMatch(profile,job as any);return{...job,id:job.id,application_id:job.application_id,facts_version:job.facts_version,job_id:job.id,lexical_score:score.score,technical_score:score.technical_score,gaps:JSON.stringify(score.gaps),matched:JSON.stringify(score.matched)};});
  const semantic=await rankWithSemantic(env,user.id,user.profile_version,profile,jobs);
  return jobs.map(job=>({...job,matching_state:semantic.state,...(semantic.items.find(item=>item.job_id===job.id)||{matching_method:'lexical',lexical_score:job.lexical_score,semantic_score:null,embedding_model:null,matching_algorithm:MATCHING_ALGORITHM}),score:semantic.items.find(item=>item.job_id===job.id)?.score??job.lexical_score}));
}
export async function addJobs(env: Env, userId: number, incoming: Row[], verifiedDiscovery=false, discovery?:{id:string;profileVersion:number}) {
  const user = await userById(env, userId);const submitted=await submittedCompanies(env,userId,user.master_profile);
  if(discovery&&user.profile_version!==discovery.profileVersion)throw new ApiError(409,'Your profile changed during job search.');
  const jobs = incoming.slice(0, 20).map(raw => {
    for (const key of ['title', 'company', 'url', 'description']) if (typeof raw[key] !== 'string' || !raw[key].trim()) throw new ApiError(422, `Job ${key} is required`);
    if (raw.description.length > 30000 || raw.title.length > 300 || raw.company.length > 300 || raw.url.length > 2000) throw new ApiError(422, 'Job data is too large');
    let url: string;
    try { url = validatePublicUrl(raw.url); } catch { throw new ApiError(422, 'Use a public HTTP(S) application URL'); }
    if(raw.application_url){try{if(typeof raw.application_url!=='string'||raw.application_url.length>2000)throw new Error();validatePublicUrl(raw.application_url);}catch{throw new ApiError(422,'Use a public HTTP(S) application URL');}}
    const listingType = raw.listing_type || user.mode;
    if (!['job', 'internship'].includes(listingType)) throw new ApiError(422, 'Invalid listing type');
    const posted = raw.posted_date ? new Date(raw.posted_date) : null;
    if (posted && !Number.isFinite(posted.getTime())) throw new ApiError(422, 'Invalid posting date');
    if(raw.expires_at&&!Number.isFinite(Date.parse(raw.expires_at)))throw new ApiError(422,'Invalid expiry date');
    const validated={...raw,provenance:verifiedDiscovery?raw.provenance:{kind:'manual',url},title:raw.title.trim(),company:raw.company.trim(),url,description:raw.description,location:String(raw.location||'').slice(0,300),listing_type:listingType,posted_date:posted?.toISOString()||null};
    // Only the server-owned discovery path can reuse its already normalized
    // facts. Caller-supplied provenance never enables this fast path.
    return verifiedDiscovery&&raw.provenance?.schema_version===LISTING_SCHEMA_VERSION
      ? validated : enrichListing(validated,extractSkills);
  });
  if (!jobs.length) return 0;
  await env.DB.batch(jobs.map(job=>env.DB.prepare(`INSERT INTO jobs(title,company,url,description,location,listing_type,posted_date,${factsColumns.join(',')}) VALUES(${Array(7+factsColumns.length).fill('?').join(',')}) ON CONFLICT(url) ${verifiedDiscovery?`DO UPDATE SET title=excluded.title,company=excluded.company,description=excluded.description,location=excluded.location,listing_type=excluded.listing_type,posted_date=excluded.posted_date,${factsColumns.map(key=>`${key}=excluded.${key}`).join(',')}`:'DO NOTHING'}`).bind(job.title,job.company,job.url,job.description,job.location,job.listing_type,job.posted_date,...factsValues(job))));
  // Known applications are refreshed lazily by getPlan's version gate. Scoring
  // them here would spend CPU/embeddings before INSERT ... DO NOTHING discards it.
  const rows = await all(env, 'SELECT j.* FROM jobs j LEFT JOIN applications a ON a.job_id=j.id AND a.user_id=? WHERE a.id IS NULL AND j.url IN (SELECT value FROM json_each(?))',userId,JSON.stringify(jobs.map(job=>job.url)));
  const scored = await scoredJobs(env,user,rows.filter(job=>eligible(job,user,submitted)));
  if(!scored.length)return 0;
  const inserted=await env.DB.batch(scored.map(job=>env.DB.prepare(`INSERT INTO applications(user_id,job_id,match_score,skill_gaps,matched_skills,scored_profile_version,scored_job_version,matching_method,lexical_score,semantic_score,embedding_model,matching_algorithm,matching_state)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND profile_version=? AND mode=?)
      AND EXISTS(SELECT 1 FROM jobs WHERE id=? AND facts_version=?)
      AND (? IS NULL OR EXISTS(SELECT 1 FROM discovery_runs WHERE id=? AND user_id=? AND profile_version=? AND state='running' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    ON CONFLICT(user_id,job_id) DO NOTHING RETURNING id`).bind(userId,job.id,job.score,job.gaps,job.matched,user.profile_version,job.facts_version,job.matching_method,job.lexical_score,job.semantic_score,job.embedding_model,job.matching_algorithm,job.matching_state,userId,user.profile_version,user.mode,job.id,job.facts_version,discovery?.id??null,discovery?.id??null,userId,user.profile_version)));

  return inserted.reduce((count,result)=>count+result.results.length,0);
}

// Plan selection and quota check happen inside single atomic D1 statements,
// avoiding profile/confirmation races without holding locks across R2 calls.
export async function getPlan(env: Env, userId: number) {
  const user = await userById(env, userId); const start = weekStart(); const submitted=await submittedCompanies(env,userId,user.master_profile);
  // One active-mode draft per poll bounds CPU. Other modes cannot enter this
  // plan and are refreshed if the owner switches back to them.
  const staleWhere="a.status IN ('pending','planned') AND j.listing_type=? AND (a.scored_profile_version<>? OR a.scored_job_version<>j.facts_version OR a.matching_algorithm IS NOT ?)";
  const stale = await all(env,`${applicationQuery} WHERE a.user_id=? AND ${staleWhere} ORDER BY a.id LIMIT 1`,userId,user.mode,user.profile_version,MATCHING_ALGORITHM);
  if(stale.length){
    const needsFacts=(row:Row)=>row.scored_job_version!==row.facts_version||row.quality_method!=='evidence_rules_v1';
    const enriched=stale.map(row=>({...row,...(needsFacts(row)?enrichListing({...row,provenance:parsed(row.provenance,{})},extractSkills):Object.fromEntries([...jsonFields].map(key=>[key,parsed(row[key],null)]))),id:row.id,job_id:row.job_id,source_job_version:row.facts_version}));
    const material=['application_url','required_skills','required_experience','expires_at','selection_process','compensation'];
    const derived=enriched.filter((_,index)=>needsFacts(stale[index]));
    const updates=derived.length?await env.DB.batch(derived.map(job=>env.DB.prepare(`UPDATE jobs SET ${factsColumns.map(key=>`${key}=?`).join(',')} WHERE id=? AND facts_version=?`).bind(...factsValues(job),job.job_id,job.source_job_version))):[];
    const current=enriched.flatMap((job,index)=>{
      const updateIndex=derived.indexOf(job);
      if(updateIndex>=0&&!updates[updateIndex].meta.changes)return [];
      const values=factsValues(job),changed=updateIndex>=0&&material.some(key=>stale[index][key]!==values[factsColumns.indexOf(key as any)]);
      return [{...job,facts_version:stale[index].facts_version+(changed?1:0)}];
    });
    const scores=await scoredJobs(env,user,current.map(job=>({...job,id:job.job_id,application_id:job.id})));
    if(scores.length)await env.DB.batch(scores.map(job=>env.DB.prepare(`UPDATE applications SET match_score=?,skill_gaps=?,matched_skills=?,scored_profile_version=?,scored_job_version=?,matching_method=?,lexical_score=?,semantic_score=?,embedding_model=?,matching_algorithm=?,matching_state=?
      WHERE id=? AND user_id=? AND status IN ('pending','planned') AND (SELECT profile_version FROM users WHERE id=?)=?
        AND EXISTS(SELECT 1 FROM jobs WHERE id=applications.job_id AND facts_version=?)`).bind(job.score,job.gaps,job.matched,user.profile_version,job.facts_version,job.matching_method,job.lexical_score,job.semantic_score,job.embedding_model,job.matching_algorithm,job.matching_state,job.application_id,userId,userId,user.profile_version,job.facts_version)));
    const pending=await first(env,`SELECT count(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=? AND ${staleWhere}`,userId,user.mode,user.profile_version,MATCHING_ALGORITHM);
    if(pending!.n)return {user_id:userId,quota:user.weekly_quota,confirmation_mode:user.confirmation_mode,plan:[],alternatives:[],preparing:true,warnings:[`Updating matches for ${pending!.n} remaining listings. The plan refreshes automatically.`]};
  }
  const planQuery=`SELECT a.*,j.title,j.company,j.url,j.location,j.listing_type,j.is_spam,j.posted_date,j.expires_at,j.source,j.canonical_url,j.application_url,j.required_skills,j.required_experience,j.compensation,j.selection_process,j.provenance,j.spam_confidence,j.quality_reason,j.quality_method,j.company_key,j.facts_version,
    (SELECT r.tailoring_metadata FROM resumes r WHERE r.application_id=a.id AND r.version=a.resume_version) AS tailoring_metadata,
    (SELECT sr.id FROM submission_reviews sr WHERE sr.application_id=a.id AND sr.profile_version=(SELECT profile_version FROM users WHERE id=a.user_id)
      AND sr.resume_version=a.resume_version AND sr.resume_path=a.resume_path AND sr.approved_at IS NOT NULL AND sr.revoked_at IS NULL
      AND sr.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY sr.created_at DESC LIMIT 1) AS review_id
    FROM applications a JOIN jobs j ON j.id=a.job_id`;
  const rows = await all(env, `${planQuery} WHERE a.user_id=? AND a.status IN ('pending','planned') ORDER BY a.match_score DESC,a.id LIMIT 200`, userId);
  const candidates: Row[] = rows.filter(row => eligible(row, user, submitted));
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
        const job = await first(env,'SELECT description,facts_version FROM jobs WHERE id=?',application.job_id);
        if(!job||job.facts_version!==application.facts_version)continue;
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
                AND (SELECT profile_version FROM users WHERE id=?)=? AND EXISTS(SELECT 1 FROM jobs WHERE id=a.job_id AND facts_version=?)) ON CONFLICT(application_id,version) DO NOTHING RETURNING id`).bind(application.id,version,key,metadata,JSON.stringify(tailored.profile),application.id,version,token,new Date().toISOString(),userId,user.profile_version,job.facts_version),
          env.DB.prepare(`UPDATE applications SET resume_path=? WHERE id=? AND resume_version=? AND status='planned' AND resume_path IS NULL
            AND (SELECT profile_version FROM users WHERE id=?)=? AND EXISTS(SELECT 1 FROM resumes WHERE application_id=? AND version=? AND object_key=?)
            AND EXISTS(SELECT 1 FROM jobs WHERE id=applications.job_id AND facts_version=?) AND EXISTS(SELECT 1 FROM resume_preparations WHERE application_id=? AND token=?) RETURNING id`).bind(key,application.id,version,userId,user.profile_version,application.id,version,key,job.facts_version,application.id,token),
        ]);
        if(!saved[1].results.length) await files(env).delete(key);
        generated++;
      } catch (error) { if(error instanceof ResumeFormatError)throw new ApiError(422,error.message);throw new ApiError(503,'Resume preparation could not finish. Please refresh your plan and review your profile.'); }
      finally { await run(env,'DELETE FROM resume_preparations WHERE application_id=? AND token=?',application.id,token); }
    }
  }
  const finalPlanned = await all(env,`${planQuery} WHERE a.user_id=? AND a.status='planned' ORDER BY a.match_score DESC,a.id`,userId);
  const alternatives = candidates.filter(a => !finalPlanned.some(p => p.id === a.id)).slice(0, 40);
  const item = (a: Row) => {const metadata=parsed<Row>(a.tailoring_metadata,{});return ({ application_id: a.id, job_id: a.job_id, role_title: a.title, company_name: a.company,
    url:a.url,source:a.source||sourceName(a.url),location:a.location || '',listing_type:a.listing_type,
    canonical_url:a.canonical_url||a.url,application_url:a.application_url||a.url,posted_date:a.posted_date,required_skills:parsed(a.required_skills,[]),required_experience:parsed(a.required_experience,null),expires_at:a.expires_at,selection_process:parsed(a.selection_process,[]),compensation:parsed(a.compensation,null),provenance:parsed(a.provenance,{}),quality:{risk:a.spam_confidence,reason:a.quality_reason,method:a.quality_method},
    matching_method:a.matching_method,matching_state:a.matching_state,embedding_model:a.embedding_model,lexical_score:a.lexical_score,semantic_score:a.semantic_score,
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
  const user = await userById(env, userId); const start = weekStart();const submitted=await submittedCompanies(env,userId,user.master_profile);
  const removeRow = await first(env, "SELECT id FROM applications WHERE user_id=? AND job_id=? AND status='planned' AND cycle_start=?", userId, remove, start);
  const addRow = await first(env, `${applicationQuery} WHERE a.user_id=? AND a.job_id=? AND a.status='pending'`, userId, add);
  if (!removeRow || !addRow || !eligible(addRow, user,submitted)) throw new ApiError(400, 'Select a currently planned job and an eligible alternative');
  // One UPDATE gives both rows the same snapshot, so a concurrent confirm cannot
  // partially remove or add a draft.
  const result = await run(env, `UPDATE applications SET status=CASE WHEN id=? THEN 'pending' ELSE 'planned' END,
    cycle_start=CASE WHEN id=? THEN NULL ELSE ? END,failure_reason=NULL
    WHERE id IN (?,?) AND (SELECT count(*) FROM applications WHERE (id=? AND status='planned' AND cycle_start=?) OR (id=? AND status='pending'))=2 RETURNING id`,
  removeRow.id, removeRow.id, start, removeRow.id, addRow.id, removeRow.id, start, addRow.id);
  if (result.results.length !== 2) throw new ApiError(409, 'Plan changed. Refresh before swapping');
  return getPlan(env, userId);
}

export async function refreshMatches(env:Env,userId:number){
  const now=Date.now(),cutoff=now-600000;
  const allowed=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,
      window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    WHERE window_start<=? OR attempts<3 RETURNING attempts`,`matching:${userId}`,now,cutoff,cutoff,cutoff);
  if(!allowed)throw new ApiError(429,'Matching was refreshed three times. Please wait ten minutes before requesting another refresh.');
  // The explicit user action can recover from an earlier model/budget outage.
  // Passive plan polling never keeps retrying expensive inference.
  await run(env,"UPDATE applications SET matching_algorithm='refresh_requested' WHERE user_id=? AND status IN ('pending','planned')",userId);
  return getPlan(env,userId);
}

export async function confirmPlan(env: Env, userId: number, ids: number[], reviewIds?: string[]) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => !Number.isSafeInteger(id))) throw new ApiError(400, 'Select distinct planned job IDs');
  const user = await userById(env, userId); const start = weekStart();const submitted=await submittedCompanies(env,userId,user.master_profile);
  const rows = await all(env, `${applicationQuery} WHERE a.user_id=? AND a.job_id IN (SELECT value FROM json_each(?))`, userId, JSON.stringify(ids));
  if((env.GEMINI_API_KEY || env.GOOGLE_API_KEY) && user.master_profile.resume_extraction_warning)
    throw new ApiError(409,'Your uploaded resume has not been fully read. Open your profile and upload it again before confirming applications.');
  if (rows.length !== ids.length || rows.some(row => row.status !== 'planned' || row.cycle_start !== start || !eligible(row, user,submitted) || !row.resume_path)) throw new ApiError(400, 'Refresh your plan and review the prepared resumes before confirming');
  if (!Array.isArray(reviewIds) || reviewIds.length!==ids.length || new Set(reviewIds).size!==reviewIds.length || reviewIds.some(id=>typeof id!=='string'||id.length>100))
    throw new ApiError(409,'Review each selected PDF and its answers before confirming.');
  const reviews=await all(env,'SELECT id,application_id FROM submission_reviews WHERE user_id=? AND id IN (SELECT value FROM json_each(?))',userId,JSON.stringify(reviewIds));
  const sources=[];
  for(const row of rows){
    const review=reviews.find(review=>review.application_id===row.id);
    if(!review || row.resume_rejected_version===row.resume_version)throw new ApiError(409,'A selected resume or answer review is missing or rejected. Review it again.');
    const valid=await getValidSubmissionReview(env,{...row,confirmed_review_id:review.id},user);
    if(!valid)throw new ApiError(409,'Your profile, listing, PDF or answers changed. Review the current version again.');
    sources.push({id:row.id,resume:row.resume_path,review_id:review.id,binding:valid.binding,company_keys:companyAliases(row.company,user.master_profile),job_snapshot:listingSnapshot(row)});
  }
  const keys = JSON.stringify(sources), now=new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE applications SET status='confirmed',failure_reason=NULL,updated_at=?,confirmed_review_id=(SELECT json_extract(value,'$.review_id') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id),job_snapshot=(SELECT json_extract(value,'$.job_snapshot') FROM json_each(?) WHERE json_extract(value,'$.id')=applications.id)
      WHERE user_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
      AND (SELECT count(*) FROM applications a JOIN json_each(?) k ON a.id=json_extract(k.value,'$.id') JOIN submission_reviews sr ON sr.id=json_extract(k.value,'$.review_id') JOIN jobs selected_job ON selected_job.id=a.job_id
        WHERE selected_job.facts_version=json_extract(k.value,'$.job_snapshot.facts_version') AND NOT EXISTS(SELECT 1 FROM applications prior JOIN jobs prior_job ON prior_job.id=prior.job_id WHERE prior.user_id=a.user_id AND prior.id<>a.id AND (prior.applied_at IS NOT NULL OR prior.status IN ('applied','interview','offer')) AND COALESCE(json_extract(prior.job_snapshot,'$.company_key'),prior_job.company_key) IN (SELECT value FROM json_each(json_extract(k.value,'$.company_keys')))) AND a.status='planned' AND a.cycle_start=? AND a.resume_path=json_extract(k.value,'$.resume') AND a.resume_rejected_version<>a.resume_version
          AND sr.application_id=a.id AND sr.user_id=a.user_id AND sr.resume_version=a.resume_version AND sr.profile_version=?
          AND sr.revoked_at IS NULL AND sr.approved_at IS NOT NULL AND sr.expires_at>? AND sr.binding=json_extract(k.value,'$.binding'))=?
      AND (SELECT count(*) FROM applications WHERE user_id=? AND cycle_start=? AND status NOT IN ('pending','planned'))+? <= (SELECT weekly_quota FROM users WHERE id=?)
      AND (SELECT profile_version FROM users WHERE id=?)=? RETURNING id`).bind(now,keys,keys,userId,keys,keys,start,user.profile_version,now,ids.length,userId,start,ids.length,userId,userId,user.profile_version),
    env.DB.prepare(`INSERT INTO outbox(application_id,kind,review_id) SELECT id,'apply',confirmed_review_id FROM applications WHERE user_id=? AND status='confirmed' AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))
      ON CONFLICT(application_id,kind) DO UPDATE SET review_id=excluded.review_id,dispatched_at=NULL WHERE outbox.review_id IS NOT excluded.review_id`).bind(userId, keys),
  ]);
  if (results[0].results.length !== ids.length) throw new ApiError(409, 'Plan or quota changed. Refresh before confirming');
  await dispatchOutbox(env);
  return { status: 'success', message: `${ids.length} applications confirmed and queued. Browser limits may require manual action.`, confirmed_job_ids: ids };
}
