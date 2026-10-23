import { ApiError, type Env, type Row, json } from './types';
import { checkAccessCode, requireUser, startSession, reserveProfileCreation } from './auth';
import { first, run, userById } from './storage';
import { extractProfile } from './intelligence';
import { classifyProviderError } from './provider_health';
import { files } from './files';

export const MAX_UPLOAD = 3 * 1024 * 1024;
export async function readJson(request: Request): Promise<Row> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(415, 'Send application/json');
  const value = await boundedBody(request, 100000);
  try {
    const body = JSON.parse(new TextDecoder().decode(value));
    if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    return body;
  } catch { throw new ApiError(422, 'Send a valid JSON object'); }
}
export async function boundedBody(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new ApiError(413, 'Request is too large');
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); throw new ApiError(413, 'Request is too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function validate(data: Row): Row {
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 200) throw new ApiError(422, 'Name must be between 1 and 200 characters');
  if (typeof data.email !== 'string' || data.email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) throw new ApiError(422, 'Enter a valid email');
  if (!['internship', 'job'].includes(data.mode)) throw new ApiError(422, 'Mode must be internship or job');
  data.weekly_quota = Number(data.weekly_quota ?? 10);
  if (!Number.isInteger(data.weekly_quota) || data.weekly_quota < 1 || data.weekly_quota > 100) throw new ApiError(422, 'Weekly quota must be between 1 and 100');
  data.experience_years = Number(data.experience_years || 0);
  if (!Number.isFinite(data.experience_years) || data.experience_years < 0 || data.experience_years > 80) throw new ApiError(422, 'Experience must be between 0 and 80 years');
  for (const field of ['skills', 'target_roles', 'preferred_locations', 'blacklist_companies', 'certifications', 'achievements', 'languages']) {
    data[field] ??= [];
    if (!Array.isArray(data[field]) || data[field].length > 100 || data[field].some((v: any) => typeof v !== 'string' || v.length > 300)) throw new ApiError(422, `${field} must be a list of strings`);
  }
  data.experience ??= []; data.projects ??= [];
  if (!Array.isArray(data.experience) || !Array.isArray(data.projects)) throw new ApiError(422, 'Experience and projects must be lists');
  for(const field of ['min_stipend','min_salary']) {
    if(data[field] == null || data[field] === '') { data[field]=null; continue; }
    const amount=Number(data[field]);
    if(!Number.isFinite(amount) || amount<0 || amount>1000000000) throw new ApiError(422,'Compensation preferences must be non-negative amounts');
    data[field]=amount;
  }
  data.links ??= [];
  if(!Array.isArray(data.links) || data.links.length>12 || data.links.some((item:any)=>{
    if(!item || typeof item.url!=='string' || item.url.length>2048 || typeof item.label!=='string' || item.label.length>100)return true;
    try {const url=new URL(item.url);return !['https:','http:'].includes(url.protocol)||!!url.username||!!url.password;}catch{return true;}
  })) throw new ApiError(422,'Profile links must be valid HTTP(S) links with a short label');
  if(data.summary!=null && (typeof data.summary!=='string' || data.summary.length>3000)) throw new ApiError(422,'Summary must be at most 3000 characters');
  if (!['batch', 'individual'].includes(data.confirmation_mode || 'batch')) throw new ApiError(422, 'Invalid confirmation mode');
  data.confirmation_mode ||= 'batch';
  data.name = data.name.trim(); data.email = data.email.trim().toLowerCase();
  return data;
}
export async function saveProfile(request: Request, env: Env, id?: number) {
  if (id) await requireUser(request, env, id); else await checkAccessCode(request, env);
  const previous = id ? await userById(env, id) : null;
  let data: Row = { ...(previous?.master_profile || {}) }; let upload: Uint8Array | undefined;
  const supplied = new Set<string>();
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const bytes = await boundedBody(request, MAX_UPLOAD + 100000);
    let form: FormData;
    try { form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData(); }
    catch { throw new ApiError(400, 'Send a valid multipart profile form'); }
    for (const [key, value] of form) if (typeof value === 'string') {
      supplied.add(key);
      if (['skills', 'target_roles', 'preferred_locations', 'experience', 'education', 'projects', 'blacklist_companies', 'links', 'certifications', 'achievements', 'languages'].includes(key)) {
        try { data[key] = JSON.parse(value); } catch {
          if (key === 'education') data[key] = value;
          else if (['skills', 'target_roles', 'preferred_locations', 'blacklist_companies', 'certifications', 'achievements', 'languages'].includes(key)) data[key] = value.split(',').map(s => s.trim()).filter(Boolean);
          else throw new ApiError(422, `${key} must contain valid JSON`);
        }
      } else if (!['id','master_resume_path','resume_text'].includes(key)) data[key] = value;
    }
    const file = form.get('resume') || form.get('file');
    if (file && typeof file !== 'string') {
      if (file.size > MAX_UPLOAD) throw new ApiError(413, 'Resume PDF must be at most 3 MB');
      upload = new Uint8Array(await file.arrayBuffer());
      if (new TextDecoder().decode(upload.slice(0, 5)) !== '%PDF-') throw new ApiError(400, 'Upload a readable PDF resume');
      // PDF-only signup can learn identity from extraction. Reserve only after
      // the bounded multipart envelope and PDF signature have been checked,
      // and before any external provider work. Failed provider calls count.
      if (!id) await reserveProfileCreation(request, env);
      if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY || !data.name || !data.email) {
        try {
          for(const field of ['name','email','phone'])if(typeof data[field]==='string'&&!data[field].trim())delete data[field];
          const extracted=await extractProfile(env,upload);
          // A replacement PDF refreshes its facts. Unchanged values posted by
          // the editor must not keep the old PDF's experience or projects.
          // Explicit edits still take precedence; preferences remain unchanged.
          for(const key of ['name','email','phone','skills','experience','projects','education','experience_years','summary','links','certifications','achievements','languages']) {
            const unchanged = previous && JSON.stringify(data[key]) === JSON.stringify(previous.master_profile[key]);
            const empty = data[key] == null || data[key] === '' || Array.isArray(data[key]) && !data[key].length;
            if(!supplied.has(key) || unchanged || empty) data[key]=extracted[key];
          }
          data={...extracted,...data};
          data.resume_extraction_model=extracted.resume_extraction_model;
          data.resume_extraction_fallback_used=extracted.resume_extraction_fallback_used;
          delete data.resume_extraction_warning;
        } catch(error) {
          const failure=classifyProviderError('gemini',error);
          console.warn(JSON.stringify({event:'resume_extraction_failed',kind:failure.kind,correlation_id:env.OPERATION_CONTEXT?.correlation_id}));
          // Never save a partly read PDF as a complete resume. Existing profile
          // data and its original file remain intact when extraction fails.
          return json({detail:`We could not finish reading your resume. ${failure.message} Your saved profile has not been changed.`,provider_failure:failure.toJSON()},failure.kind==='rate_limited'?429:503,failure.retry_after_seconds?{'Retry-After':String(failure.retry_after_seconds)}:{});
        }
      } else {
        data.resume_extraction_warning='Automatic resume reading is unavailable. Review your generated PDF and add your experience and projects before confirming applications.';
      }
    }
  } else data = { ...data, ...(await readJson(request)) };
  // Storage paths are server-owned. Clients cannot reference another user's PDFs.
  delete data.id; delete data.resume_text;
  data.master_resume_path = previous?.master_profile?.master_resume_path || null;
  validate(data);
  if (await first(env, 'SELECT id FROM users WHERE email=? AND id<>?', data.email, id || -1)) throw new ApiError(409, 'A profile with this email already exists');
  // Manual/JSON signup spends quota only after full validation. Invalid input
  // cannot exhaust the global daily budget for every other visitor.
  if (!id && !upload) await reserveProfileCreation(request, env);
  let objectKey: string | undefined;
  if (upload) {
    objectKey = `uploads/${crypto.randomUUID()}.pdf`;
    await files(env).put(objectKey, upload, { httpMetadata: { contentType: 'application/pdf' } });
    data.master_resume_path = objectKey;
  }
  try {
    if (id) {
      await env.DB.batch([
        env.DB.prepare('UPDATE users SET name=?,email=?,mode=?,weekly_quota=?,confirmation_mode=?,master_profile=?,profile_version=profile_version+1 WHERE id=?').bind(data.name, data.email, data.mode, data.weekly_quota, data.confirmation_mode, JSON.stringify(data), id),
        env.DB.prepare("UPDATE applications SET resume_path=NULL WHERE user_id=? AND status IN ('pending','planned')").bind(id),
      ]);
    } else {
      const result = await run(env, 'INSERT INTO users(name,email,mode,weekly_quota,confirmation_mode,master_profile) VALUES(?,?,?,?,?,?)', data.name, data.email, data.mode, data.weekly_quota, data.confirmation_mode, JSON.stringify(data));
      id = Number(result.meta.last_row_id);
    }
  } catch {
    if (objectKey) await files(env).delete(objectKey);
    throw new ApiError(409, 'Profile could not be saved; the email may already exist');
  }
  return json(await userById(env, id!), previous ? 200 : 201, previous ? {} : { 'Set-Cookie': await startSession(request, env, id!) });
}
