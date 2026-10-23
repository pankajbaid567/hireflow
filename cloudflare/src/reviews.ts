import { ApiError, type Env, type Row, parsed } from './types';
import { all, applicationQuery, first, run, userById } from './storage';
import { digest } from './auth';
import { files } from './files';
import { createResume, ResumeFormatError } from './pdf';
import { validatePublicUrl } from './automation';
import { normalizeReviewQuestion } from './review_contract';

export const normalizeQuestion = normalizeReviewQuestion;
const text = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const editable = ['summary', 'skills', 'experience', 'projects', 'education', 'links', 'certifications', 'achievements', 'languages'];
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Row)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const jobFingerprint = (app: Row) => digest(stable({ url: app.url, title: app.title, company: app.company, description: app.description,
  posted_date:app.posted_date??null,application_url:app.application_url??app.url,location:app.location??null,listing_type:app.listing_type??null,expires_at:app.expires_at??null,
  required_experience:parsed(app.required_experience,null),compensation:parsed(app.compensation,null),selection_process:parsed(app.selection_process,[]) }));
export const buildReviewBinding = (value: Row) => digest(stable({ application_id: value.application_id, user_id: value.user_id, profile_version: value.profile_version,
  resume_version: value.resume_version, resume_path: value.resume_path, resume_hash: value.resume_hash, jd_hash: value.jd_hash, answers: parsed(value.answers, {}) }));
export async function ownedApplication(env: Env, userId: number, appId: number) {
  const app = await first(env, `${applicationQuery} WHERE a.id=? AND a.user_id=?`, appId, userId);
  if (!app) throw new ApiError(404, 'Application not found');
  return app;
}
function requireEditable(app: Row) {
  if (app.status !== 'planned') throw new ApiError(409, 'Cancel queued work before editing. An application that may have started cannot be changed here.');
}
export async function resumeDraft(env: Env, userId: number, appId: number) {
  const app = await ownedApplication(env, userId, appId), user = await userById(env, userId);
  const versions = await all(env, 'SELECT version,created_at,tailoring_metadata,profile_snapshot FROM resumes WHERE application_id=? ORDER BY version DESC LIMIT 10', app.id);
  const current = versions.find(row => row.version === app.resume_version);
  if (!current || !app.resume_path) throw new ApiError(409, 'Prepare a resume in the weekly plan first.');
  const metadata = parsed<Row>(current.tailoring_metadata, {});
  const stored = parsed<Row>(current.profile_snapshot, {});
  const draft = Object.keys(stored).length ? stored : { ...user.master_profile,
    ...(metadata.summary ? { summary: metadata.summary } : {}),
    ...(Array.isArray(metadata.project_indices) ? { projects: metadata.project_indices.map((index: number) => user.master_profile.projects?.[index]).filter(Boolean) } : {}) };
  return { application_id: app.id, resume_version: app.resume_version, profile_version: user.profile_version, rejected: app.resume_rejected_version === app.resume_version,
    draft, previous_draft: versions[1] ? parsed<Row>(versions[1].profile_snapshot,{summary:parsed<Row>(versions[1].tailoring_metadata,{}).summary || ''}) : null,
    versions: versions.map(row => ({ version: row.version, created_at: row.created_at, method: parsed<Row>(row.tailoring_metadata, {}).method || 'legacy',
      summary: parsed<Row>(row.profile_snapshot, {}).summary || parsed<Row>(row.tailoring_metadata, {}).summary || '',
      download_url: `/resumes/${userId}/${app.id}/download?version=${row.version}` })) };
}
function validateDraft(input: unknown, previous: Row): Row {
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new ApiError(422, 'Provide the resume fields to edit.');
  if (JSON.stringify(input).length > 65000) throw new ApiError(413, 'Resume edits are too large.');
  const profile: Row = { ...previous };
  for (const key of editable) if (Object.hasOwn(input, key)) profile[key] = (input as Row)[key];
  if (profile.summary != null && (typeof profile.summary !== 'string' || profile.summary.length > 3000)) throw new ApiError(422, 'Summary must be at most 3000 characters.');
  for (const key of ['skills', 'certifications', 'achievements', 'languages']) {
    if (profile[key] == null) profile[key] = [];
    if (!Array.isArray(profile[key]) || profile[key].length > 100 || profile[key].some((value: unknown) => typeof value !== 'string' || value.length > 500)) throw new ApiError(422, `${key} must contain short text entries.`);
  }
  for (const key of ['experience', 'projects']) if (!Array.isArray(profile[key] || []) || profile[key]?.length > 25) throw new ApiError(422, `${key} must contain up to 25 entries.`);
  if (!Array.isArray(profile.links || []) || profile.links?.length > 12) throw new ApiError(422, 'Use up to 12 profile links.');
  for (const link of profile.links || []) {
    try { const url = new URL(link.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(); }
    catch { throw new ApiError(422, 'Use valid HTTP(S) profile links.'); }
  }
  return profile;
}
export async function editResume(env: Env, userId: number, appId: number, data: Row) {
  const app = await ownedApplication(env, userId, appId); requireEditable(app);
  if (data.base_version !== app.resume_version || !app.resume_path) throw new ApiError(409, 'The resume changed. Reload the editor before saving.');
  const previous = await resumeDraft(env, userId, appId), user = await userById(env, userId);
  if (data.profile_version !== user.profile_version) throw new ApiError(409, 'Your profile changed. Prepare and review the current resume first.');
  const draft = validateDraft(data.draft, previous.draft), version = app.resume_version + 1;
  const key = `resumes/${userId}/${app.job_id}_resume_v${version}_${crypto.randomUUID()}.pdf`;
  let bytes: Uint8Array;
  try { bytes = createResume(draft, app, parsed(app.matched_skills, [])); }
  catch (error) { throw new ApiError(422, error instanceof ResumeFormatError?error.message:'This resume could not be formatted. Shorten overly long fields and try again.'); }
  await files(env).put(key, bytes, { httpMetadata: { contentType: 'application/pdf' } });
  const now = new Date().toISOString();
  try {
    const result = await env.DB.batch([
      env.DB.prepare(`INSERT INTO resumes(application_id,version,object_key,profile_snapshot,tailoring_metadata)
        SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications WHERE id=? AND user_id=? AND status='planned' AND resume_version=? AND resume_path=? AND (SELECT profile_version FROM users WHERE id=?)=? AND EXISTS(SELECT 1 FROM jobs WHERE id=applications.job_id AND facts_version=?))
        ON CONFLICT(application_id,version) DO NOTHING RETURNING id`).bind(app.id, version, key, JSON.stringify(draft), JSON.stringify({ method: 'user_edited', summary: draft.summary || '', profile_version: user.profile_version, previous_version: app.resume_version, warnings: [] }), app.id, userId, app.resume_version, app.resume_path, userId, user.profile_version,app.facts_version),
      env.DB.prepare(`UPDATE applications SET resume_version=?,resume_path=?,resume_rejected_version=0,confirmed_review_id=NULL,updated_at=? WHERE id=? AND user_id=? AND status='planned' AND resume_version=?
        AND EXISTS(SELECT 1 FROM jobs WHERE id=applications.job_id AND facts_version=?) AND EXISTS(SELECT 1 FROM resumes WHERE application_id=? AND version=? AND object_key=?) RETURNING id`).bind(version, key, now, app.id, userId, app.resume_version, app.facts_version, app.id, version, key),
      env.DB.prepare('UPDATE submission_reviews SET revoked_at=? WHERE application_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM applications WHERE id=? AND resume_version=?)').bind(now, app.id, app.id, version),
    ]);
    if (!result[1].results.length) { await files(env).delete(key); throw new ApiError(409, 'The plan changed. Reload before editing this resume.'); }
  } catch (error) { await files(env).delete(key); throw error; }
  return resumeDraft(env, userId, appId);
}
export async function rejectResume(env: Env, userId: number, appId: number, data: Row) {
  const app = await ownedApplication(env, userId, appId); requireEditable(app);
  if (data.resume_version !== app.resume_version) throw new ApiError(409, 'The resume changed. Review the current version.');
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE applications SET resume_rejected_version=resume_version,confirmed_review_id=NULL,failure_reason='Resume rejected. Edit or regenerate it before reviewing again.' WHERE id=? AND user_id=? AND status='planned' AND resume_version=? RETURNING id").bind(app.id, userId, app.resume_version),
    env.DB.prepare('UPDATE submission_reviews SET revoked_at=? WHERE application_id=? AND revoked_at IS NULL').bind(now, app.id),
  ]);
  if (!result[0].results.length) throw new ApiError(409, 'The plan changed. Refresh before rejecting.');
  return { rejected: true, resume_version: app.resume_version };
}
export async function regenerateResume(env: Env, userId: number, appId: number, data: Row) {
  const app = await ownedApplication(env, userId, appId); requireEditable(app);
  if (data.resume_version !== app.resume_version) throw new ApiError(409, 'The resume changed. Refresh before regenerating.');
  const now = Date.now(), cutoff = now - 600000;
  const allowed = await first(env, `INSERT INTO resume_retry_limits(application_id,attempts,window_start) VALUES(?,1,?)
    ON CONFLICT(application_id) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
    WHERE window_start<=? OR attempts<3 RETURNING attempts`, app.id, now, cutoff, cutoff, cutoff);
  if (!allowed) throw new ApiError(429, 'Three resume preparations were requested. Please wait ten minutes before retrying.');
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE applications SET resume_path=NULL,resume_rejected_version=0,confirmed_review_id=NULL WHERE id=? AND user_id=? AND status='planned' AND resume_version=? RETURNING id").bind(app.id, userId, app.resume_version),
    env.DB.prepare('UPDATE submission_reviews SET revoked_at=? WHERE application_id=? AND revoked_at IS NULL').bind(new Date(now).toISOString(), app.id),
  ]);
  if (!result[0].results.length) throw new ApiError(409, 'The plan changed. Refresh before regenerating.');
  return { preparing: true, message: 'A new draft will be prepared when you refresh the plan. Review it before applying.' };
}
const commonQuestions = ['Why do you want to work here?', 'Why are you interested in this role?', 'Tell us about yourself', 'Describe your relevant experience', 'Cover letter'];
function cleanMarkup(value: string) { return value.replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|quot|#39|lt|gt);/g, ' ').replace(/\s+/g, ' ').trim(); }
async function formQuestions(url: string): Promise<string[]> {
  // Read-only, bounded public HTML inspection; no login, script execution or POST.
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(validatePublicUrl(url), { redirect: 'manual', signal: controller.signal, headers: { Accept: 'text/html' } });
    if (!response.ok || !(response.headers.get('content-type') || '').includes('text/html')) { await response.body?.cancel(); return []; }
    const reader = response.body?.getReader(); if (!reader) return [];
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 262144) { await reader.cancel(); return []; } chunks.push(next.value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const html = new TextDecoder().decode(bytes), questions: string[] = [];
    for (const match of html.matchAll(/<textarea\b([^>]*)>/gi)) {
      const attrs = match[1], id = attrs.match(/\bid\s*=\s*["']([^"']+)["']/i)?.[1];
      let label: string|undefined;
      if (id) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        label = html.match(new RegExp(`<label\\b[^>]*\\bfor=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/label>`, 'i'))?.[1];
      }
      if(!label){
        const before=html.slice(0,match.index),open=before.toLowerCase().lastIndexOf('<label'),closed=before.toLowerCase().lastIndexOf('</label>');
        if(open>closed){const end=html.toLowerCase().indexOf('</label>',match.index);if(end>=0)label=html.slice(open,end).replace(/<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi,'');}
      }
      label ||= attrs.match(/(?:aria-label|placeholder)\s*=\s*["']([^"']+)["']/i)?.[1];
      label ||= attrs.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
      if (label) questions.push(cleanMarkup(label).slice(0, 250));
      if (questions.length >= 12) break;
    }
    return questions;
  } catch { return []; } finally { clearTimeout(timer); }
}
function draftAnswer(question: string, app: Row, draft: Row): string {
  if (/eligib|authori[sz]|visa|sponsor|salary|stipend|notice|availability|start date|relocat|disabil|gender|ethnic|veteran|criminal|consent/i.test(question)) return '';
  const summary = text(draft.summary, 1200);
  return [`I am interested in the ${text(app.title, 200)} opportunity at ${text(app.company, 200)}.`, summary].filter(Boolean).join(' ').slice(0, 1800);
}
export async function reviewQuestions(env: Env, userId: number, appId: number) {
  const app = await ownedApplication(env, userId, appId); requireEditable(app);
  const resume = await resumeDraft(env, userId, appId);
  const previous=await first(env,'SELECT id,answers FROM submission_reviews WHERE application_id=? AND user_id=? AND resume_version=? AND profile_version=? AND revoked_at IS NULL AND approved_at IS NOT NULL AND expires_at>? ORDER BY created_at DESC LIMIT 1',app.id,userId,app.resume_version,resume.profile_version,new Date().toISOString());
  const existing=previous?parsed<Record<string,string>>(previous.answers,{}):{};
  const labels=new Map<string,string>();
  for(const question of [...await formQuestions(app.url),...commonQuestions,...Object.keys(existing)]){const normalized=normalizeQuestion(question);if(normalized&&!labels.has(normalized))labels.set(normalized,question);}
  const names=[...labels.values()].slice(0,30);
  return { ...resume, questions: names.map(question => ({ question, answer: existing[normalizeQuestion(question)] || draftAnswer(question, app, resume.draft), source: existing[normalizeQuestion(question)]?'previously_reviewed':'verified_resume_facts' })),
    message: 'Review the PDF and these answers. Add any other known application questions. Unreviewed or sensitive required questions will need your action.' };
}
function validatedAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 30) throw new ApiError(422, 'Provide up to 30 reviewed application answers.');
  const answers: Record<string, string> = {};
  for (const [question, answer] of Object.entries(value)) {
    const key = normalizeQuestion(question);
    if (!key || key.length > 250 || typeof answer !== 'string' || answer.length > 3000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(answer)) throw new ApiError(422, 'Use a short question and an answer of at most 3000 characters.');
    if(Object.hasOwn(answers,key))throw new ApiError(422,'Use each application question once.');
    if (answer.trim()) answers[key] = answer.trim();
  }
  if (JSON.stringify(answers).length > 40000) throw new ApiError(413, 'Reviewed answers are too large.');
  return answers;
}
export async function createSubmissionReview(env: Env, userId: number, appId: number, data: Row) {
  const app = await ownedApplication(env, userId, appId); requireEditable(app);
  const user = await userById(env, userId);
  if (data.resume_version !== app.resume_version || data.profile_version !== user.profile_version || !app.resume_path || app.resume_rejected_version === app.resume_version)
    throw new ApiError(409, 'Review the current, non-rejected PDF before approving.');
  if (data.reviewed !== true) throw new ApiError(422, 'Confirm that you reviewed the PDF and answers.');
  const object = await files(env).get(app.resume_path); if (!object) throw new ApiError(409, 'The reviewed PDF is not available yet. Refresh shortly.');
  const bytes = await object.arrayBuffer(), now = new Date().toISOString();
  const review: Row = { id: crypto.randomUUID(), application_id: app.id, user_id: userId, profile_version: user.profile_version,
    resume_version: app.resume_version, resume_path: app.resume_path, resume_hash: await hashBytes(bytes), jd_hash: await jobFingerprint(app),
    answers: validatedAnswers(data.answers), expires_at: new Date(Date.now() + 24 * 3600000).toISOString() };
  review.binding = await buildReviewBinding(review);
  const result = await env.DB.batch([env.DB.prepare(`INSERT INTO submission_reviews(id,application_id,user_id,profile_version,resume_version,resume_path,resume_hash,jd_hash,binding,answers,created_at,expires_at,approved_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=? AND a.user_id=? AND a.status='planned' AND a.resume_version=? AND a.resume_path=? AND a.resume_rejected_version<>a.resume_version AND u.profile_version=?) RETURNING id`)
    .bind(review.id, app.id, userId, user.profile_version, app.resume_version, app.resume_path, review.resume_hash, review.jd_hash, review.binding, JSON.stringify(review.answers), now, review.expires_at, now,
      app.id, userId, app.resume_version, app.resume_path, user.profile_version),
    env.DB.prepare('UPDATE submission_reviews SET revoked_at=? WHERE application_id=? AND id<>? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM submission_reviews WHERE id=?)').bind(now,app.id,review.id,review.id),
  ]);
  if (!result[0].results.length) throw new ApiError(409, 'The plan changed while reviewing. Refresh before approving.');
  return { review_id: review.id, binding: review.binding, resume_version: app.resume_version, profile_version: user.profile_version, expires_at: review.expires_at, approved: true };
}
async function hashBytes(bytes: ArrayBuffer | Uint8Array) {
  const hash = await crypto.subtle.digest('SHA-256', bytes instanceof Uint8Array ? new Uint8Array(bytes).buffer : bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export async function getValidSubmissionReview(env: Env, application: Row, user: Row, resumeBytes?: Uint8Array) {
  if (!application.confirmed_review_id) return null;
  const review = await first(env, 'SELECT * FROM submission_reviews WHERE id=? AND application_id=? AND user_id=? AND revoked_at IS NULL AND approved_at IS NOT NULL AND expires_at>?',
    application.confirmed_review_id, application.id, application.user_id, new Date().toISOString());
  if (!review || review.profile_version !== user.profile_version || review.resume_version !== application.resume_version || review.resume_path !== application.resume_path || review.jd_hash !== await jobFingerprint(application) || review.binding !== await buildReviewBinding(review)) return null;
  if (resumeBytes && review.resume_hash !== await hashBytes(resumeBytes)) return null;
  return { binding: review.binding as string, answers: parsed<Record<string, string>>(review.answers, {}), reviewId: review.id as string };
}
export async function validateSubmissionReview(env: Env, reviewId: string, binding: string) {
  const review = await first(env, 'SELECT * FROM submission_reviews WHERE id=?', reviewId); if (!review || review.binding !== binding) return false;
  const app = await first(env, `${applicationQuery} WHERE a.id=?`, review.application_id);
  if (!app || app.confirmed_review_id!==reviewId || !['confirmed', 'applying'].includes(app.status)) return false;
  const current=await getValidSubmissionReview(env, app, await userById(env, app.user_id));
  return current?.reviewId===reviewId&&current.binding===binding;
}
export async function cancelQueuedApplication(env: Env, userId: number, appId: number) {
  const app = await ownedApplication(env, userId, appId);
  if (app.status !== 'confirmed') throw new ApiError(409, app.status === 'applying' ? 'Execution has started. Check the employer site; cancellation cannot guarantee withdrawal.' : 'Only queued applications can be cancelled here.');
  const now = new Date().toISOString();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE applications SET status='planned',confirmed_review_id=NULL,failure_reason='Queued application cancelled before execution. Review again to authorize.',updated_at=? WHERE id=? AND user_id=? AND status='confirmed' RETURNING id").bind(now, app.id, userId),
    env.DB.prepare("UPDATE submission_reviews SET revoked_at=? WHERE application_id=? AND revoked_at IS NULL AND EXISTS(SELECT 1 FROM applications WHERE id=? AND status='planned' AND confirmed_review_id IS NULL)").bind(now, app.id, app.id),
    env.DB.prepare("DELETE FROM outbox WHERE application_id=? AND kind='apply' AND EXISTS(SELECT 1 FROM applications WHERE id=? AND status='planned' AND confirmed_review_id IS NULL)").bind(app.id, app.id),
  ]);
  if (!result[0].results.length) throw new ApiError(409, 'Execution has started. Check the employer site before taking further action.');
  return { cancelled: true, status: 'planned', message: 'Cancelled before execution. Nothing was submitted by this queue attempt. Review again if you wish to requeue.' };
}
