import type { Env } from './types';
import {readPublicSource,reserveDiscoveryUsage,SourceDeferred} from './source_reader';
import { buildEvidencePrepGuide } from './prep_intelligence';
import { compensationFit, enrichListing, experienceFit, parseCompensation, parseExperience } from './listing_details';
import { classifyProviderError, recordProviderOutcome, type ProviderName } from './provider_health';
import { structuredJobLocation } from './structured_location';

type Data = Record<string, any>;
type JobInput = { title: string; description?: string; listing_type?: string; location?: string; company?: string; required_skills?: string[] | string; required_experience?: Data | string | null; compensation?: Data | string | null; spam_confidence?: number | null };
type SearchResult = { title: string; url: string; content: string; published_date?: string; company?: string; location?: string };
type DiscoveredJob = { title: string; company: string; url: string; description: string; location?: string; listing_type: 'job' | 'internship'; posted_date?: string };
type DiscoveryTrace = Record<string, string | number | boolean>;
export type DiscoverySourceSummary = { id: string; name: string; searched: number; verified: number; restricted: number; status: 'ok' | 'empty' | 'restricted' | 'unavailable' | 'budget_limited'; search_calls: number };
type DiscoveryDiagnostics = { warn(message: string): void; trace?(data: DiscoveryTrace): void; report?(sources: DiscoverySourceSummary[]): void };
const VOCABULARY = ['Python', 'JavaScript', 'TypeScript', 'Java', 'Go', 'Rust', 'C++', 'C#', 'SQL', 'HTML', 'CSS', 'React', 'Next.js', 'Node.js', 'FastAPI', 'Django', 'Flask', 'Spring', 'LangChain', 'LangGraph', 'RAG', 'multi-agent systems', 'Docker', 'Kubernetes', 'AWS', 'Azure', 'GCP', 'PostgreSQL', 'MongoDB', 'Redis', 'Git', 'Linux', 'TensorFlow', 'PyTorch', 'scikit-learn', 'Pandas', 'NumPy', 'machine learning', 'deep learning', 'data structures', 'algorithms', 'system design', 'REST', 'GraphQL', 'Terraform', 'CI/CD', 'Kotlin', 'Swift', 'Ruby', 'PHP', 'Vue', 'Angular', 'Excel'];
const ALIASES: Record<string, string[]> = {
  JavaScript: ['js'], TypeScript: ['ts'], 'Node.js': ['nodejs'], 'Next.js': ['nextjs'], React: ['reactjs'],
  PostgreSQL: ['postgres'], Kubernetes: ['k8s'], Go: ['golang'], RAG: ['retrieval augmented generation', 'retrieval-augmented generation'],
  'multi-agent systems': ['multi agent systems'],
};
const text = (value: unknown, limit = 20000): string => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(v => typeof v === 'string').map(v => v.trim()).filter(Boolean).slice(0, 100) : [];
const key = (value: unknown): string => {
  const result = text(value, 2048);
  return !result || /^(none|null|undefined)$/i.test(result) || /your_|placeholder/i.test(result) ? '' : result;
};
const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function hasSkill(source: string, skill: string): boolean {
  return [skill, ...(ALIASES[skill] || [])].some(alias => {
    if (alias === 'Go') return /\bGo\b/.test(source);
    return new RegExp(`(^|[^\\w+#])${escape(alias)}(?=$|[^\\w+#])`, 'i').test(source);
  });
}
const canonicalNames = new Map(VOCABULARY.flatMap(skill => [skill, ...(ALIASES[skill] || [])].map(alias => [alias.toLowerCase(), skill] as const)));
// Compile once and scan the JD once. Recompiling/scanning one regex per skill
// for every listing is too expensive for the Workers Free CPU budget.
const skillPattern = new RegExp(`(?<![\\w+#])(${[...canonicalNames.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\w+#])`, 'gi');
const customMatchers = new Map<string, RegExp>();
function customSkillsIn(source: string, skills: string[]): string[] {
  const custom = skills.filter(skill => !canonicalNames.has(skill.toLowerCase()));
  if (!custom.length) return [];
  const signature = JSON.stringify(custom);
  let pattern = customMatchers.get(signature);
  if (!pattern) {
    pattern = new RegExp(`(?<![\\w+#])(${[...custom].sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\w+#])`, 'gi');
    if (customMatchers.size >= 16) customMatchers.delete(customMatchers.keys().next().value!);
    customMatchers.set(signature, pattern);
  }
  pattern.lastIndex = 0;
  const found = new Set([...source.matchAll(pattern)].map(match => match[0].toLowerCase()));
  return custom.filter(skill => found.has(skill.toLowerCase()));
}
function canonical(skill: string): string {
  return canonicalNames.get(skill.trim().toLowerCase()) || skill.trim();
}
export function extractSkills(source: string): string[] {
  const found = new Set<string>();
  skillPattern.lastIndex = 0;
  for (const match of text(source, 50000).matchAll(skillPattern)) {
    const value = canonicalNames.get(match[0].toLowerCase())!;
    if (value !== 'Go' || match[0] === 'Go' || match[0].toLowerCase() === 'golang') found.add(value);
  }
  return VOCABULARY.filter(skill => found.has(skill));
}

export function scoreMatch(profile: Data, job: JobInput): { score: number; gaps: string[]; matched: string[]; skills: string[]; technical_score: number; factors: Record<string,number> } {
  const jd = text(job.description, 50000), title = text(job.title, 1000), all = `${title} ${jd}`;
  const supplied = [...new Map(strings(profile.skills).map(canonical).map(skill => [skill.toLowerCase(), skill])).values()];
  const fromJson=(value:any,fallback:any)=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};
  const explicit=strings(fromJson(job.required_skills,[])).map(canonical);
  const skills = [...new Set([...(explicit.length?explicit:extractSkills(all)), ...customSkillsIn(all, supplied)])];
  const user = new Set(supplied.map(s => s.toLowerCase()));
  const matched = skills.filter(s => user.has(s.toLowerCase())), gaps = skills.filter(s => !user.has(s.toLowerCase()));
  const roles = strings(profile.target_roles);
  const titleWords = new Set(title.toLowerCase().split(/\s+/));
  const role = roles.length ? Math.max(...roles.map(r => {
    const words = r.toLowerCase().split(/\s+/);
    return words.filter(w => titleWords.has(w)).length / words.length;
  })) : 0.5;
  const years = Math.max(0, Number(profile.experience_years) || 0);
  const requirement=fromJson(job.required_experience,null) || parseExperience(jd);
  // Numeric requirements take precedence. A team mentioning senior colleagues
  // is not itself a senior vacancy; title hints are used only if years are absent.
  const senior = /\b(senior|lead|principal|staff|architect|director|vp|head)\b/i.test(title);
  const junior = /\b(junior|entry|graduate|fresher|trainee|intern|internship|apprentice|associate)\b/i.test(title);
  const experience = requirement?experienceFit(requirement,years):junior&&years<=2?1:senior&&years<2?.2:.5;
  const locations = strings(profile.preferred_locations).map(v => v.toLowerCase()), location = text(job.location).toLowerCase();
  const locationScore = !locations.length || !location ? 0.5 : locations.some(v => location.includes(v) || v.includes(location)) ? 1 : location.includes('remote') ? 0.8 : 0.2;
  const compensation = compensationFit(fromJson(job.compensation,null) || parseCompensation(jd),profile,job.listing_type || profile.mode || 'job');
  // This signal describes listing evidence quality, never employer prestige.
  const quality=typeof job.spam_confidence==='number'?Math.max(0,1-job.spam_confidence):text(job.company)?0.5:0;
  const technical_score=skills.length?matched.length/skills.length:0;
  const factors={skill_match:technical_score,role_fit:role,experience_fit:experience,location_match:locationScore,compensation_fit:compensation,company_signal:quality};
  const score = .4*technical_score+.2*role+.15*experience+.1*locationScore+.1*compensation+.05*quality;
  return { score: Math.round(Math.max(0, Math.min(1, score)) * 10000) / 10000, gaps, matched, skills, technical_score, factors };
}

class IntelligenceError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false, readonly category?: string, readonly retryAfter?: string | null) { super(message); }
}
const responseControllers = new WeakMap<Response, AbortController>();
async function boundedFetch(url: string, init: RequestInit = {}, timeout = 15000): Promise<Response> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  try { const response = await fetch(url, { ...init, signal: controller.signal }); responseControllers.set(response, controller); return response; }
  catch (error) {
    // Classify locally without exposing the original message, which can contain
    // a credential-bearing URL, header value, or private request data.
    const message = error instanceof Error ? error.message : '';
    const category = /redirect/i.test(message) ? 'invalid_redirect' : /header|bytestring|invalid character/i.test(message) ? 'invalid_headers' : controller.signal.aborted || /abort|timeout/i.test(message) ? 'timeout' : 'network';
    throw new IntelligenceError('External service request failed or timed out', undefined, !category.startsWith('invalid_'), category);
  }
  finally { clearTimeout(timer); }
}
async function jsonResponse(response: Response, label: string, timeout = 15000): Promise<Data> {
  if (!response.ok) { await response.body?.cancel(); throw new IntelligenceError(`${label} request failed (HTTP ${response.status})`, response.status, [408, 429, 500, 502, 503, 504].includes(response.status),undefined,response.headers.get('retry-after')); }
  const timer = setTimeout(() => responseControllers.get(response)?.abort(), timeout);
  try {
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Data;
  } catch { const timedOut=Boolean(responseControllers.get(response)?.signal.aborted);throw new IntelligenceError(`${label} returned an invalid response`,undefined,timedOut,timedOut?'timeout':'malformed'); }
  finally { clearTimeout(timer); responseControllers.delete(response); }
}
function geminiKey(env: Env): string { return key(env.GEMINI_API_KEY) || key(env.GOOGLE_API_KEY); }
function configured(env: Env): boolean {
  const provider = text(env.LLM_PROVIDER) || 'groq';
  return provider === 'gemini' ? Boolean(geminiKey(env)) : provider === 'groq' ? Boolean(key(env.GROQ_API_KEY)) : true;
}
function responseText(data: Data): string {
  if (typeof data.output_text === 'string') return data.output_text.trim();
  const steps = Array.isArray(data.steps) ? data.steps : Array.isArray(data.outputs) ? data.outputs : [];
  return steps.filter((s: Data) => !s.type || ['model_output', 'text'].includes(s.type)).flatMap((s: Data) => typeof s.text === 'string' ? [s.text] : Array.isArray(s.content) ? s.content.filter((p: Data) => p.type === 'text').map((p: Data) => text(p.text)) : []).join('\n').trim();
}
async function generateTextRaw(env: Env, prompt: string): Promise<string> {
  const provider = text(env.LLM_PROVIDER) || 'groq';
  const deadline=Date.now()+15000,remaining=()=>Math.max(1,deadline-Date.now());
  if (!['groq', 'gemini'].includes(provider)) throw new IntelligenceError('Configure LLM_PROVIDER as groq or gemini for the Worker runtime');
  let answer = '';
  if (provider === 'groq') {
    const apiKey = key(env.GROQ_API_KEY);
    if (!apiKey) throw new IntelligenceError('GROQ_API_KEY is required when LLM_PROVIDER=groq');
    const data = await jsonResponse(await boundedFetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: text(env.GROQ_MODEL) || 'openai/gpt-oss-20b', messages: [{ role: 'user', content: text(prompt, 50000) }], temperature: 0, max_completion_tokens: 4096, reasoning_effort: 'low' }),
    }, remaining()), 'Groq',remaining());
    answer = text(data.choices?.[0]?.message?.content, 50000);
  } else {
    const apiKey = geminiKey(env);
    if (!apiKey) throw new IntelligenceError('GEMINI_API_KEY or GOOGLE_API_KEY is required when LLM_PROVIDER=gemini');
    const data = await jsonResponse(await boundedFetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: (text(env.GEMINI_MODEL) || 'gemini-3.8-flash').replace(/^models\//, ''), input: text(prompt, 50000), store: false, generation_config: { max_output_tokens: 4096, thinking_level: 'medium' } }),
    }, remaining()), 'Gemini',remaining());
    if (data.status && data.status !== 'completed') throw new IntelligenceError('Gemini did not complete the response');
    answer = responseText(data);
  }
  if (!answer) throw new IntelligenceError(`${provider === 'groq' ? 'Groq' : 'Gemini'} returned no answer text`);
  return answer;
}
export async function generateText(env: Env, prompt: string): Promise<string> {
  const provider: ProviderName = env.LLM_PROVIDER === 'gemini' ? 'gemini' : 'groq';
  const model = provider === 'groq' ? env.GROQ_MODEL || 'openai/gpt-oss-20b' : env.GEMINI_MODEL || 'gemini-3.8-flash';
  const started = Date.now();
  try {
    const answer = await generateTextRaw(env,prompt);
    await recordProviderOutcome(env,provider,model,{success:true,latency_ms:Date.now()-started,operation:'provider_text'});
    return answer;
  } catch (error) {
    const failure = classifyProviderError(provider,error,{notConfigured:!['groq','gemini'].includes(env.LLM_PROVIDER || 'groq')||!configured(env),retryAfter:error instanceof IntelligenceError?error.retryAfter:undefined});
    await recordProviderOutcome(env,provider,model,{success:false,latency_ms:Date.now()-started,failure,operation:'provider_text'});
    if (error instanceof Error) Object.assign(error,{provider_failure:failure});
    throw error;
  }
}
function jsonObject(raw: string): Data {
  const start = raw.indexOf('{'), end = raw.lastIndexOf('}');
  try {
    const value = JSON.parse(raw.slice(start, end + 1));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new IntelligenceError('Profile extraction returned invalid JSON'); }
}
async function extractProfileRaw(env: Env, pdf: Uint8Array): Promise<Data> {
  const apiKey = geminiKey(env);
  if (!apiKey) throw new IntelligenceError('PDF profile extraction requires GEMINI_API_KEY or GOOGLE_API_KEY');
  if (pdf.byteLength > 5 * 1024 * 1024) throw new IntelligenceError('PDF profile extraction supports files up to 5 MB');
  if (new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new IntelligenceError('Upload a valid PDF resume');
  const prompt = 'Extract all factual resume content, including every experience role, project, education entry and bullet, as one JSON object. Preserve dates, names, grades/CGPA, metrics and actual hyperlink URLs when available; never invent a URL for a link label; do not summarize away accomplishments. Required: name:string,email:string,phone:string,summary:string,links:array of objects with label/url:string,certifications:string[],achievements:string[],languages:string[](spoken human languages only; programming languages belong in skills),skills:string[],mode:"job"|"internship",weekly_quota:integer(default10),target_roles:string[],preferred_locations:string[],experience_years:number(default0),experience:array of objects with title/company/dates:string and bullets:string[],education:array of objects with degree/institution/year/gpa:string,projects:array of objects with name/description:string and tech:string[]. Missing lists must be []; missing strings must be "". Do not invent skills, employers, credentials or accomplishments. Return raw JSON only.';
  const model = (text(env.GEMINI_MODEL) || 'gemini-3.8-flash').replace(/^models\//, '');
  const fallback = text(env.GEMINI_FALLBACK_MODEL).replace(/^models\//, '');
  if (![model, ...(fallback ? [fallback] : [])].every(value => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,120}$/.test(value))) throw new IntelligenceError('Configure valid Gemini extraction model IDs');
  // Keep extraction (including response bodies and cleanup) below the frontend's
  // 60-second proxy timeout. Reserve three seconds for remote-file deletion.
  const deadline = Date.now() + 45000, large = pdf.byteLength > 32768;
  const remaining = (maximum = 40000): number => {
    const value = Math.min(maximum, deadline - Date.now() - (large ? 3000 : 0));
    if (value <= 0) throw new IntelligenceError('PDF profile extraction timed out; try again or enter your profile manually');
    return value;
  };
  const requestJson = async (url: string, init: RequestInit, label: string, maximum = 40000): Promise<Data> => {
    const stageDeadline = Date.now() + remaining(maximum);
    // workerd accepts manual/follow, while Node also accepts error. Never follow
    // provider redirects: credentials and uploaded documents stay at their URL.
    const response = await boundedFetch(url, { ...init, redirect: 'manual' }, remaining(maximum));
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new IntelligenceError(`${label} returned an unexpected redirect`); }
    const bodyTimeout = Math.min(remaining(15000), stageDeadline - Date.now());
    if (bodyTimeout <= 0) { await response.body?.cancel(); throw new IntelligenceError(`${label} request timed out`); }
    return jsonResponse(response, label, bodyTimeout);
  };
  // A caller-supplied ID makes cleanup possible even if upload finalization's
  // response is lost. No original filename or personal information is retained.
  const fileName = large ? `files/hf-${crypto.randomUUID().replaceAll('-', '')}` : '';
  let cleanupName = '', fileUrl = '';
  try {
    let document: Data;
    if (large) {
      const response = await boundedFetch('https://generativelanguage.googleapis.com/upload/v1beta/files', {
        method: 'POST', redirect: 'manual', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(pdf.byteLength), 'X-Goog-Upload-Header-Content-Type': 'application/pdf' },
        body: JSON.stringify({ file: { name: fileName, display_name: 'hireflow-resume.pdf' } }),
      }, remaining(5000));
      const uploadLocation = response.headers.get('X-Goog-Upload-URL');
      await response.body?.cancel();
      if (!response.ok) throw new IntelligenceError(`Gemini PDF upload request failed (HTTP ${response.status})`);
      let uploadUrl: URL;
      try { uploadUrl = new URL(uploadLocation || ''); } catch { throw new IntelligenceError('Gemini PDF upload returned an invalid upload destination'); }
      if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== 'generativelanguage.googleapis.com' || uploadUrl.port || uploadUrl.username || uploadUrl.password || !uploadUrl.pathname.startsWith('/upload/')) throw new IntelligenceError('Gemini PDF upload returned an invalid upload destination');
      cleanupName = fileName;
      let uploaded = await requestJson(uploadUrl.toString(), {
        method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/pdf', 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
        // Fetch sends the existing byte buffer directly; no multi-MB JS string
        // or base64 JSON allocation on the Workers Free CPU path.
        body: pdf as Uint8Array<ArrayBuffer>,
      }, 'Gemini PDF upload', 10000);
      if (!/^files\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(uploaded.file?.name || '')) throw new IntelligenceError('Gemini PDF upload returned an invalid file reference');
      cleanupName = uploaded.file.name;
      fileUrl = `https://generativelanguage.googleapis.com/v1beta/${cleanupName}`;
      const pollDeadline = Date.now() + 10000;
      for (let polls = 0; uploaded.file?.state === 'PROCESSING' && polls < 3; polls += 1) {
        if (uploaded.file.name !== cleanupName || Date.now() + 1000 >= pollDeadline) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, remaining(1000))));
        uploaded = { file: await requestJson(fileUrl, { headers: { 'x-goog-api-key': apiKey } }, 'Gemini PDF processing', Math.max(1, Math.min(3000, pollDeadline - Date.now()))) };
      }
      if (uploaded.file?.name !== cleanupName || uploaded.file?.uri !== fileUrl) throw new IntelligenceError('Gemini PDF upload returned an invalid file reference');
      if (uploaded.file.state !== 'ACTIVE') throw new IntelligenceError('Gemini PDF is not ready for extraction; try again or enter your profile manually');
      document = { fileData: { mimeType: 'application/pdf', fileUri: fileUrl } };
    } else {
      // Inline processing avoids creating a remote file for tiny documents.
      document = { inlineData: { mimeType: 'application/pdf', data: btoa(String.fromCharCode(...pdf)) } };
    }
    // Preserve the requested primary, retry transient failures only, and use an
    // alternate model only when the owner explicitly configured one. Reuse the
    // same file reference; cleanup happens once after the entire recovery path.
    const useFallback = fallback && fallback !== model;
    const models = [model, model, ...(useFallback ? [fallback] : [])];
    let data: Data | undefined, extractionModel = model;
    for (let attempt = 0; attempt < models.length; attempt += 1) {
      if (attempt === 1 && useFallback && remaining() <= 16000) continue;
      extractionModel = models[attempt];
      const budget = extractionModel === model ? useFallback ? Math.max(1000, Math.min(12000, remaining() - 15000)) : 20000 : 40000;
      try {
        data = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(extractionModel)}:generateContent`, {
          method: 'POST', headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, document] }], generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096 } }),
        }, 'Gemini PDF extraction', budget);
        break;
      } catch (error) {
        // A provider-wide rate limit is not solved by immediately changing the
        // model. Let the user retry after the bounded Retry-After interval.
        if(error instanceof IntelligenceError && error.status===429)throw error;
        if (!(error instanceof IntelligenceError) || !error.retryable || attempt === models.length - 1) throw error;
        // No provider body, applicant data, upload URL, or key enters logs.
        console.warn(JSON.stringify({ event: 'gemini_pdf_recovery', model: extractionModel, attempt: attempt + 1, status: error.status || 'network', category: error.category || 'http', next: models[attempt + 1] }));
        const delay = attempt === 0 ? 1000 : 2000;
        if (remaining() <= delay + 1000) throw new IntelligenceError('PDF profile extraction timed out; try again or enter your profile manually');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    if (!data) throw new IntelligenceError('Gemini PDF extraction did not return a completed response');
    const parts = data.candidates?.[0]?.content?.parts;
    const raw = (Array.isArray(parts) ? parts : []).filter((part: Data) => part && !part.thought && typeof part.text === 'string').map((part: Data) => part.text).join('\n');
    const profile = jsonObject(raw);
    if (!text(profile.name) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(profile.email))) throw new IntelligenceError('Resume must contain an identifiable name and email; enter your profile manually');
    return { name: text(profile.name, 200), email: text(profile.email, 320), phone: text(profile.phone, 100), summary: text(profile.summary, 3000), links: Array.isArray(profile.links) ? profile.links.filter((item: Data) => item && typeof item.url === 'string' && /^https?:\/\//i.test(item.url.trim())).slice(0, 12).map((item: Data) => ({ label: text(item.label, 100), url: text(item.url, 2048) })) : [], certifications: strings(profile.certifications), achievements: strings(profile.achievements), languages: strings(profile.languages), skills: [...new Set(strings(profile.skills).map(canonical))], mode: profile.mode === 'internship' ? 'internship' : 'job', weekly_quota: Math.max(1, Math.min(100, Number(profile.weekly_quota) || 10)), experience_years: Math.max(0, Math.min(80, Number(profile.experience_years) || 0)), target_roles: strings(profile.target_roles), preferred_locations: strings(profile.preferred_locations), experience: Array.isArray(profile.experience) ? profile.experience : [], education: Array.isArray(profile.education) || typeof profile.education === 'object' && profile.education ? profile.education : text(profile.education), projects: Array.isArray(profile.projects) ? profile.projects : [], resume_extraction_model: extractionModel, resume_extraction_fallback_used: extractionModel !== model };
  } finally {
    if (cleanupName) {
      try {
        const response = await boundedFetch(`https://generativelanguage.googleapis.com/v1beta/${cleanupName}`, { method: 'DELETE', redirect: 'manual', headers: { 'x-goog-api-key': apiKey } }, Math.max(1, Math.min(3000, deadline - Date.now())));
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) throw new Error();
      } catch { throw new IntelligenceError('Gemini temporary resume cleanup could not be confirmed; delete the uploaded file in Google AI Studio before retrying'); }
    }
  }
}
export async function extractProfile(env: Env, pdf: Uint8Array): Promise<Data> {
  const started=Date.now();
  try {
    const profile=await extractProfileRaw(env,pdf);
    await recordProviderOutcome(env,'gemini',profile.resume_extraction_model || env.GEMINI_MODEL || 'gemini-3.8-flash',{success:true,latency_ms:Date.now()-started,operation:'provider_extract'});
    return profile;
  } catch(error) {
    const failure=classifyProviderError('gemini',error,{notConfigured:!geminiKey(env),retryAfter:error instanceof IntelligenceError?error.retryAfter:undefined});
    // Invalid uploads never become a failed model health check.
    if(pdf.byteLength<=5*1024*1024 && new TextDecoder().decode(pdf.subarray(0,5))==='%PDF-' && geminiKey(env))
      await recordProviderOutcome(env,'gemini',env.GEMINI_MODEL || 'gemini-3.8-flash',{success:false,latency_ms:Date.now()-started,failure,operation:'provider_extract'});
    if(error instanceof Error) Object.assign(error,{provider_failure:failure});
    throw error;
  }
}

function publicUrl(raw: unknown): string | null {
  try {
    const url = new URL(text(raw, 2048)), host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port && !['80', '443'].includes(url.port)) return null;
    if (!host.includes('.') || /(^|\.)(localhost|local|internal|test|invalid)$/.test(host) || host === 'metadata.google.internal') return null;
    if (host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) && (() => { const [a, b] = host.split('.').map(Number); return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0 || a === 100 && b >= 64 && b <= 127; })()) return null;
    url.hash = ''; return url.toString();
  } catch { return null; }
}
class Budget {
  used = 0;
  constructor(private readonly deadline = Infinity, private readonly trace?: (data: DiscoveryTrace) => void,private readonly sourceEnv?:Env) {}
  get exhausted(): boolean { return this.used >= 24 || Date.now() >= this.deadline; }
  remaining(maximum = 15000): number {
    const remaining = Math.min(maximum, this.deadline - Date.now());
    if (remaining <= 0) throw new IntelligenceError('Research time budget reached');
    return remaining;
  }
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    if (this.used >= 24) throw new IntelligenceError('Research request budget reached');
    this.remaining(); // Never reserve another shared request after the task deadline.
    this.used += 1;
    const host = new URL(url).hostname;
    try {
      const shared=this.sourceEnv?.DISCOVERY_SHARED_GUARDS==='true';
      const provider=host==='api.tavily.com'||host==='serpapi.com';
      if(shared&&provider)await reserveDiscoveryUsage(this.sourceEnv!,'searches');
      let response:Response;
      if(shared&&!provider){
        try{response=await readPublicSource(this.sourceEnv!,url,init);}
        catch(error){
          // A canonical same-host redirect or HEAD→GET fallback must not
          // restart forever at its first hop. Wait once, preserving the shared
          // host reservation; no network/quota attempt occurred on this denial.
          if(!(error instanceof SourceDeferred)||error.attempted||error.delaySeconds>2||/Daily discovery/.test(error.reason)||this.remaining()<=error.delaySeconds*1000+100)throw error;
          await new Promise(resolve=>setTimeout(resolve,error.delaySeconds*1000));
          response=await readPublicSource(this.sourceEnv!,url,init);
        }
      }else response=await boundedFetch(url,{...init,redirect:'manual'},this.remaining(this.deadline===Infinity?15000:7000));
      this.trace?.({ stage: 'fetch', host, status: response.status, cache:response.headers.get('X-HireFlow-Source-Cache')||'none' });
      return response;
    } catch (error) {
      this.trace?.({ stage: 'fetch', host, status: 0, category: error instanceof IntelligenceError ? error.category || 'request' : 'request' });
      throw error;
    }
  }
}
function searchReady(env: Env): boolean { return Boolean(key(env.TAVILY_API_KEY) || key(env.SERPAPI_API_KEY)); }
async function searchRaw(env: Env, query: string, budget: Budget, news = false, jobs = false, domains?: string[], jobLimit = 8): Promise<SearchResult[]> {
  let response: Response;
  if (key(env.TAVILY_API_KEY)) {
    // Search locates candidate URLs; only the independently fetched source
    // page/API can supply a verified JD. Asking Tavily for all raw pages here
    // duplicates those downloads and JSON decoding without adding evidence.
    response = await budget.fetch('https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ api_key: key(env.TAVILY_API_KEY), query: text(query, 500), max_results: jobs ? jobLimit : 6, topic: news ? 'news' : 'general', ...(news ? { time_range: 'year' } : jobs ? { time_range: 'month', include_published_date: true, include_raw_content: false, ...(domains ? { include_domains: domains } : {}) } : {}) }) });
  } else if (key(env.SERPAPI_API_KEY)) {
    const url = new URL('https://serpapi.com/search.json');
    url.search = new URLSearchParams({ api_key: key(env.SERPAPI_API_KEY), q: `${text(query, 500)}${jobs && domains ? ` (${domains.map(domain => `site:${domain}`).join(' OR ')})` : ''}`, engine: 'google', num: jobs ? String(jobLimit) : '6', ...(news ? { tbm: 'nws', tbs: 'qdr:m3' } : jobs ? { tbs: 'qdr:m' } : {}) }).toString();
    response = await budget.fetch(url.toString());
  } else throw new IntelligenceError('Configure TAVILY_API_KEY or SERPAPI_API_KEY for live discovery and research');
  const data = await jsonResponse(response, 'Search provider', budget.remaining());
  if (data.error) throw new IntelligenceError('Search provider could not complete the query');
  const values = data.results || (news ? data.news_results : data.organic_results) || [];
  if (!Array.isArray(values)) throw new IntelligenceError('Search provider returned invalid results');
  return values.filter(r => r && typeof r === 'object' && !Array.isArray(r)).slice(0, jobs ? jobLimit : 6).map((r: Data) => ({ title: text(r.title, 300), url: text(r.url || r.link, 2048), content: text(r.content || r.snippet, 2000), published_date: text(r.published_date || r.published_at || r.date, 100), company: text(r.company, 200), location: text(r.location, 200) }));
}
async function search(env: Env, query: string, budget: Budget, news = false, jobs = false, domains?: string[], jobLimit = 8): Promise<SearchResult[]> {
  const provider:ProviderName=key(env.TAVILY_API_KEY)?'tavily':'serpapi',started=Date.now();
  try {const result=await searchRaw(env,query,budget,news,jobs,domains,jobLimit);await recordProviderOutcome(env,provider,'search',{success:true,latency_ms:Date.now()-started,operation:'provider_search'});return result;}
  catch(error){if(error instanceof SourceDeferred)throw error;const failure=classifyProviderError(provider,error,{notConfigured:!searchReady(env),retryAfter:error instanceof IntelligenceError?error.retryAfter:undefined});await recordProviderOutcome(env,provider,'search',{success:false,latency_ms:Date.now()-started,failure,operation:'provider_search'});if(error instanceof Error)Object.assign(error,{provider_failure:failure});throw error;}
}
async function accessible(raw: unknown, budget: Budget): Promise<string | null> {
  let url = publicUrl(raw);
  if (!url) return null;
  try {
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      let response = await budget.fetch(url, { method: 'HEAD', redirect: 'manual' });
      if ([405, 501].includes(response.status)) { await response.body?.cancel(); response = await budget.fetch(url, { method: 'GET', headers: { Range: 'bytes=0-1023' }, redirect: 'manual' }); }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('Location'); await response.body?.cancel();
        url = location ? publicUrl(new URL(location, url).toString()) : null;
        if (!url) return null;
        continue;
      }
      const ok = response.ok; await response.body?.cancel(); return ok ? url : null;
    }
  } catch { /* Unreachable sources are omitted, including when the budget runs out. */ }
  return null;
}
export async function buildPrepGuide(env: Env, profile: Data, job: Data): Promise<Data> {
  const budget=new Budget(Date.now()+45000,undefined,env);
  return buildEvidencePrepGuide(env,profile,job,{
    skills:extractSkills,canonical,hasSkill,searchReady:searchReady(env),configured:configured(env),
    search:(query,news=false)=>search(env,query,budget,news),accessible:url=>accessible(url,budget),publicUrl,
    page:async url=>{const source=await detailBody(url,budget);return source?{...source,text:htmlText(source.body)}:null;},
    generate:prompt=>generateText(env,prompt),
    failureMessage:error=>error instanceof IntelligenceError?error.message:'invalid response',
  });
}

function listingUrl(raw: unknown): string | null {
  const safe = publicUrl(raw); if (!safe) return null;
  const url = new URL(safe), host = url.hostname.replace(/^www\./, ''), path = url.pathname;
  // Public ATS identifiers live in the path; these two documented referral
  // fields are tracking there. Other career pages may use them as job IDs.
  if (/^(jobs\.(?:eu\.)?lever\.co|(?:job-)?boards\.greenhouse\.io|jobs\.ashbyhq\.com)$/.test(host)) {url.searchParams.delete('ref');url.searchParams.delete('source');}
  if (/^(jobs\.(?:eu\.)?lever\.co|(?:job-)?boards\.greenhouse\.io|jobs\.ashbyhq\.com)$/.test(host)) url.protocol = 'https:';
  if (/(^|\.)(linkedin\.com)$/.test(host) && !/^\/jobs\/view\/[^/]+/.test(path)) return null;
  if (host === 'internshala.com' && !/^\/(internship|job)\/detail\/[^/]+/.test(path)) return null;
  if (host === 'naukri.com' && !/^\/job-listings-[^/]+/.test(path)) return null;
  if (/(^|\.)(indeed\.com|indeed\.co\.in)$/.test(host) && !(url.searchParams.get('jk') && /\/(viewjob|rc\/clk)/.test(path))) return null;
  if (/(^|\.)lever\.co$/.test(host) && !/^\/[^/]+\/[^/]+/.test(path)) return null;
  if (/(^|\.)ashbyhq\.com$/.test(host) && !/^\/[^/]+\/[^/]+/.test(path)) return null;
  if (!/\/(jobs?|careers?|positions?|openings?|vacancies|job-listing|internship)\/.+/i.test(path) && !/^(jobs\.(?:eu\.)?lever\.co|jobs\.ashbyhq\.com|naukri\.com|internshala\.com)$/.test(host) && !/\.myworkdayjobs\.com$/.test(host) && !/(^|\.)indeed\./.test(host)) return null;
  for (const name of [...url.searchParams.keys()]) if (/^(utm_|referrer$|trackingid$|gh_src$)/i.test(name)) url.searchParams.delete(name);
  return url.toString();
}
function listingIdentity(url: string): string {
  const parsed = new URL(url); parsed.pathname = parsed.pathname.replace(/\/apply\/?$/, '').replace(/\/$/, ''); return parsed.toString();
}
const namedHtmlEntities: Record<string,string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' };
const hiddenHtmlElements = new Set(['script', 'style', 'nav', 'footer', 'header']);
const hiddenHtmlClosers = Object.fromEntries([...hiddenHtmlElements].map(name => [name, new RegExp(`</${name}(?=[\\s>])`, 'gi')]));
/** Bounded linear scan: a truncated/unclosed tag must not make a broad HTML
 * regex retry against each '<' in a large script payload. Invisible content
 * is skipped before entity decoding; an unclosed hidden element stays hidden.
 */
function visibleHtml(raw: string): string {
  if (!raw.includes('<')) return raw;
  const parts: string[] = []; let cursor = 0;
  while (cursor < raw.length) {
    const opening = raw.indexOf('<', cursor);
    if (opening < 0) { parts.push(raw.slice(cursor)); break; }
    parts.push(raw.slice(cursor, opening));
    if (raw.startsWith('<!--', opening)) {
      const end = raw.indexOf('-->', opening + 4);
      if (end < 0) break;
      cursor = end + 3; parts.push(' '); continue;
    }
    const end = raw.indexOf('>', opening + 1);
    if (end < 0) break;
    const name = raw.slice(opening + 1, Math.min(end, opening + 16)).match(/^([a-z][\w:-]*)\b/i)?.[1]?.toLowerCase();
    if (name && hiddenHtmlElements.has(name)) {
      // Match against original text: lowercasing a whole Unicode page can
      // expand characters (for example İ) and corrupt source offsets.
      const closer = hiddenHtmlClosers[name]; closer.lastIndex = end + 1;
      const closing = closer.exec(raw)?.index ?? -1;
      // The source may be truncated by the bounded reader. Never turn a
      // dangling script/navigation body into a job description or banner.
      if (closing < 0) break;
      const closingEnd = raw.indexOf('>', closing + name.length + 2);
      if (closingEnd < 0) break;
      cursor = closingEnd + 1; parts.push(' '); continue;
    }
    cursor = end + 1; parts.push('\n');
  }
  return parts.join('');
}
function htmlText(raw: string): string {
  // Remove actual script/navigation payloads before decoding their entities.
  // Recheck after decoding too: Greenhouse can send escaped HTML markup.
  let value = visibleHtml(raw.slice(0, 180000));
  let decoded = false;
  for (let pass = 0; pass < 2 && value.includes('&'); pass++) value = value.replace(/&(?:amp|lt|gt|quot|apos|nbsp);|&#(?:x[\da-f]+|\d+);/gi, entity => {
    decoded = true;
    const named = namedHtmlEntities[entity.toLowerCase()];
    if (named) return named;
    const point = entity[2]?.toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1));
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : ' ';
  });
  if (decoded && value.includes('<')) value = visibleHtml(value);
  return value.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim().slice(0, 30000);
}
function jobPosting(html: string): Data | null {
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]); const pending: unknown[] = Array.isArray(value) ? [...value] : [value];
      for (let scanned = 0; pending.length && scanned < 40; scanned++) {
        const item = pending.shift(); if (!item || typeof item !== 'object') continue;
        const node = item as Data, types = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
        if (types.includes('JobPosting')) return node;
        for (const child of [node['@graph'], node.mainEntity]) if (child) pending.push(...(Array.isArray(child) ? child : [child]));
      }
    } catch { /* Unrelated malformed page metadata is not a job posting. */ }
  }
  return null;
}
async function detailBody(raw: string, budget: Budget): Promise<{ url: string; body: string } | null> {
  let url = publicUrl(raw); if (!url) return null;
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await budget.fetch(url, { headers: { Accept: 'text/html, application/json' } });
    if (response.status >= 300 && response.status < 400) {
      const destination = response.headers.get('Location'); await response.body?.cancel();
      url = destination ? publicUrl(new URL(destination, url).toString()) : null; if (!url) return null; continue;
    }
    if (!response.ok) { await response.body?.cancel(); return null; }
    const reader = response.body?.getReader(); if (!reader) return { url, body: '' };
    const limit=new URL(url).hostname==='api.ashbyhq.com'?4*1024*1024:180000;
    const chunks: Uint8Array[] = []; let length = 0;
    const controller = responseControllers.get(response), timer = setTimeout(() => controller?.abort(), budget.remaining(4000));
    try {
      while (length < limit) {
        const part = await reader.read(); if (part.done) break;
        const bytes = part.value.subarray(0, limit - length); chunks.push(bytes); length += bytes.length;
      }
      if (length >= limit) await reader.cancel();
      // Typical ATS JSON fits one chunk; avoid copying the entire document
      // before decoding it. Multiple chunks still preserve split UTF-8 safely.
      let bytes = chunks[0] || new Uint8Array();
      if (chunks.length > 1) { bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } }
      return { url, body: new TextDecoder().decode(bytes) };
    } finally { clearTimeout(timer); responseControllers.delete(response); }
  }
  return null;
}
function sourcedNames(result: SearchResult, url: string): { title: string; company: string } {
  let title = result.title.replace(/^Job Application for\s+/i, '').replace(/\s*[|–-]\s*(LinkedIn|Indeed|Naukri(?:\.com)?|Wellfound|Internshala).*$/i, '').trim();
  let company = result.company || '';
  const at = title.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  if (at) { title = at[1]; company ||= at[2]; }
  else {
    const parts = title.split(/\s+[–|]\s+|\s+-\s+/);
    if (parts.length >= 2) {
      const role = /\b(engineer|developer|intern|internship|analyst|designer|associate|research|scientist|manager|specialist)\b/i;
      if (/^jobs\.(?:eu\.)?lever\.co$/.test(new URL(url).hostname) && role.test(parts.slice(1).join(' ')) && !role.test(parts[0])) { company ||= parts.shift()!; title = parts.join(' - '); }
      else if (!role.test(parts.at(-1)!)) { company ||= parts.pop()!; title = parts.join(' - '); }
    }
  }
  const parsed = new URL(url);
  if (!company && /^(jobs\.(?:eu\.)?lever\.co|(?:job-)?boards\.greenhouse\.io|jobs\.ashbyhq\.com)$/.test(parsed.hostname)) company = parsed.pathname.split('/').filter(Boolean)[0] || '';
  return { title: text(title, 300), company: text(company, 300) };
}
async function listingDetails(result: SearchResult, url: string, budget: Budget, trace?: (data: DiscoveryTrace) => void, env?: Env): Promise<DiscoveredJob | null> {
  const parsed = new URL(url), segments = parsed.pathname.split('/').filter(Boolean), names = sourcedNames(result, url);
  const reject = (reason: string): null => { trace?.({ stage: 'rejected', host: parsed.hostname, reason }); return null; };
  let title = names.title, company = names.company, description = '', location = result.location || '', employment = '', posted = '', validThrough = '';
  let verifiedUrl = url, structured = false; let evidence:Data={kind:'page_text',url}; let structuredPay:Data|null=null;let declaredSkills:string[]=[];let applicationUrl=url;
  // Public read-only ATS endpoints avoid JS-only application pages and expose
  // complete descriptions without authentication or speculative LLM extraction.
  let api = '';
  if (/^jobs\.(?:eu\.)?lever\.co$/.test(parsed.hostname)) api = `https://api.${parsed.hostname.includes('.eu.') ? 'eu.' : ''}lever.co/v0/postings/${encodeURIComponent(segments[0])}/${encodeURIComponent(segments[1])}?mode=json`;
  else if (/^(?:job-)?boards\.greenhouse\.io$/.test(parsed.hostname) && segments[1] === 'jobs' && /^\d+$/.test(segments[2] || '')) api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(segments[0])}/jobs/${segments[2]}`;
  if(parsed.hostname==='jobs.ashbyhq.com')api=`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(segments[0])}?includeCompensation=true`;
  if (api) {
    const detail = await detailBody(api, budget); if (!detail) return reject('unavailable_detail');
    try {
      let data = JSON.parse(detail.body);
      if(parsed.hostname==='jobs.ashbyhq.com'){
        if(!Array.isArray(data.jobs))return reject('invalid_ashby_board');
        const listingPath=parsed.pathname.replace(/\/(?:apply|application)\/?$/,'').replace(/\/$/,'');
        data=data.jobs.find((item:Data)=>{if(!item||typeof item!=='object'||Array.isArray(item))return false;const candidate=publicUrl(item.jobUrl);return item.isListed===true&&candidate&&new URL(candidate).hostname==='jobs.ashbyhq.com'&&new URL(candidate).pathname.replace(/\/$/,'')===listingPath;});
        if(!data)return reject('unlisted_or_closed_ashby_job');
        verifiedUrl=publicUrl(data.jobUrl)!;applicationUrl=verifiedUrl;
      }
      title = text(data.text || data.title, 300) || title;
      company=text(data.company_name,300)||company;
      description = htmlText(data.descriptionPlain || data.content || data.descriptionHtml || data.description || '');
      if(data.compensation?.scrapeableCompensationSalarySummary)description+='\nCompensation: '+text(data.compensation.scrapeableCompensationSalarySummary,1000);
      if (Array.isArray(data.lists)) description += '\n' + data.lists.slice(0, 10).map((part: Data) => `${text(part.text)}\n${htmlText(text(part.content))}`).join('\n');
      description += '\n' + text(data.additionalPlain || '');
      location = text(data.categories?.location || (typeof data.location==='string'?data.location:data.location?.name),300) || location;
      if(data.absolute_url&&publicUrl(data.absolute_url))applicationUrl=publicUrl(data.absolute_url)!;
      if(data.applyUrl){const candidate=publicUrl(data.applyUrl);if(candidate&&new URL(candidate).hostname===parsed.hostname)applicationUrl=candidate;}
      employment = text(data.categories?.commitment || data.employmentType); structured = true; evidence={kind:'ats_api',url:api};
      structuredPay=data.salaryRange?{currency:data.salaryRange.currency,value:{minValue:data.salaryRange.min,maxValue:data.salaryRange.max,unitText:data.salaryRange.interval}}:null;
      if(parsed.hostname==='jobs.ashbyhq.com'){
        const pay=data.compensation,components=Array.isArray(pay?.summaryComponents)?pay.summaryComponents:Array.isArray(pay?.compensationTiers)&&pay.compensationTiers.length===1?pay.compensationTiers[0]?.components:[];
        const salary=Array.isArray(components)?components.filter((item:Data)=>item.compensationType==='Salary'&&typeof item.currencyCode==='string'&&(Number.isFinite(item.minValue)||Number.isFinite(item.maxValue))):[];
        if(salary.length===1){const value=salary[0],unit=String(value.interval||'').replace(/^1\s+/,'');structuredPay={currency:value.currencyCode,value:{minValue:value.minValue,maxValue:value.maxValue,unitText:unit}};}
      }
      // Greenhouse updated_at is an edit time, not a posting date.
      if (data.createdAt||data.publishedAt||data.first_published) posted = new Date(data.createdAt||data.publishedAt||data.first_published).toISOString();
    } catch { return reject('invalid_ats_response'); }
  } else {
    let detail = await detailBody(url, budget); if (!detail || !listingUrl(detail.url)) return reject('unavailable_detail');
    verifiedUrl = listingUrl(detail.url)!;applicationUrl=verifiedUrl;
    let posting = jobPosting(detail.body);
    let visible = htmlText(detail.body);
    let renderedMethod:string|null=null;
    if(/\b(?:verify (?:that )?you are human|checking your browser|access to this page has been denied|log ?in to view (?:this|the) job|sign in to view (?:this|the) job|complete (?:the |a )?captcha challenge)\b/i.test(visible.slice(0,12000)))return reject('restricted_source_interstitial');
    if (/\b(?:this (?:vacancy|job|position|role)(?: has)?(?: now)? (?:expired|closed|been filled)|no longer accepting applications|job is no longer available|position has been filled)\b/i.test(visible.slice(0, 16000))) return reject('expired_banner');
    // Hydrate only explicitly configured public sources after static access and
    // closure checks. A browser cannot be used to bypass a restricted response.
    if(env?.DYNAMIC_SOURCE_ENABLED==='true'&&(!posting||htmlText(text(posting.description,60000)).length<100)){
      const {readDynamicPublicSource,DynamicSourceRejected}=await import('./dynamic_source');
      try{
        const rendered=await readDynamicPublicSource(env,verifiedUrl,{timeoutMs:budget.remaining(20000),initialDocument:detail});
        if(rendered){
          const final=listingUrl(rendered.headers.get('X-HireFlow-Source-URL')||verifiedUrl);
          if(!final)return reject('invalid_rendered_listing_url');
          const body=await rendered.text();posting=jobPosting(body);
          if(!posting)return reject('missing_rendered_job_fields');
          detail={url:final,body};verifiedUrl=final;applicationUrl=final;visible=htmlText(body);
          renderedMethod=rendered.headers.get('X-HireFlow-Dynamic-Method');
          // Fetch timing and resource counts belong to the attempt trace, not
          // versioned listing facts that would invalidate an unchanged review.
          const rendering:DiscoveryTrace={stage:'rendered_source',host:new URL(final).hostname,method:renderedMethod||'unknown',fetched_at:rendered.headers.get('X-HireFlow-Fetched-At')||'',initial_document_reused:rendered.headers.get('X-HireFlow-Rendered-Document-Reused')==='true',browser_close_acknowledged:rendered.headers.get('X-HireFlow-Browser-Close-Acknowledged')==='true'};
          for(const[header,field]of [['X-HireFlow-Rendered-Native-Reads','native_reads'],['X-HireFlow-Rendered-D1Calls','d1_calls'],['X-HireFlow-Rendered-Bytes','resource_bytes']]){const value=rendered.headers.get(header);if(value&&/^\d{1,8}$/.test(value))rendering[field]=Number(value);}
          trace?.(rendering);
        }
      }catch(error){if(error instanceof SourceDeferred)throw error;if(error instanceof DynamicSourceRejected)return reject('rendered_'+error.code);throw error;}
    }
    if (posting) {
      title = text(posting.title, 300) || title; company = text(posting.hiringOrganization?.name, 300) || company;
      description = htmlText(text(posting.description, 60000)); posted = text(posting.datePosted) || posted; validThrough = text(posting.validThrough);
      evidence={kind:renderedMethod?'rendered_json_ld':'json_ld',url:verifiedUrl,...(renderedMethod?{rendered_method:renderedMethod}:{})};structuredPay=posting.baseSalary || null;declaredSkills=(Array.isArray(posting.skills)?posting.skills:typeof posting.skills==='string'?posting.skills.split(/[,;|\n]/):[]).filter((value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=80).slice(0,50);
      if(declaredSkills.length)description+='\nSkills stated in metadata: '+declaredSkills.join(', ');
      employment = Array.isArray(posting.employmentType) ? posting.employmentType.join(' ') : text(posting.employmentType);
      const geography = structuredJobLocation(posting);
      location = geography.location || location;
      evidence.location = geography.evidence; structured = true;
    } else {
      // A public SPA shell can contain a large navigation/cookie payload. It is
      // still not a full JD when hydration is unavailable or not permitted.
      const shell=/\b(?:enable javascript|javascript (?:is )?required|requires javascript|loading (?:the )?(?:job|position|test metadata|opportunit)|please wait)\b/i.test(visible);
      const jobSections=/\b(?:responsibilities|qualifications|requirements|what you(?: will|'ll) do|about (?:the |this )?(?:role|position)|we are looking for|you will (?:build|develop|work|design)|required skills)\b/i.test(visible);
      if(shell&&!jobSections)return reject('unsupported_javascript_source');
      // Department/career landing pages are not individual opportunities even
      // when their search snippet mentions a role matching the query.
      if (/\/careers?\//i.test(parsed.pathname) && !/\d|(?:job|req|requisition|opening)[-_]/i.test(parsed.pathname)) return reject('career_directory');
      description = visible.length > 100 ? visible : ''; // A search snippet is not a verified full JD.
    }
  }
  description = description.trim().slice(0, 30000);
  const listingType = /\b(intern(?:ship)?|trainee|apprentice)\b/i.test(`${title} ${employment}`) ? 'internship' : 'job';
  const published = Date.parse(posted), expires = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(validThrough) ? `${validThrough}T23:59:59.999Z` : validThrough);
  if (Number.isFinite(expires) && expires < Date.now()) return reject('expired_date');
  if (Number.isFinite(published) && (published < Date.now() - 30 * 86400000 || published > Date.now() + 86400000)) return reject('outside_freshness_window');
  if (!title || !company || description.length < 100 || /\b(?:search results|job vacancies|jobs? in |careers? at |find .*jobs|all openings|\d+ .*jobs)\b/i.test(title)) return reject('missing_job_fields');
  if (!structured && /\b(?:this (?:vacancy|job|position|role)(?: has)?(?: now)? (?:expired|closed|been filled)|no longer accepting applications|job is no longer available)\b/i.test(description.slice(0, 16000))) return reject('expired_description');
  return enrichListing({ title, company, url: verifiedUrl,application_url:applicationUrl,description, listing_type: listingType, provenance:evidence, required_skills:declaredSkills,structured_compensation:structuredPay, expires_at:validThrough || null, ...(location ? { location } : {}), ...(Number.isFinite(published) ? { posted_date: new Date(published).toISOString() } : {}) },extractSkills) as DiscoveredJob;
}
export async function discoverJobs(env: Env, profile: Data, diagnostics?: DiscoveryDiagnostics): Promise<DiscoveredJob[]> {
  if (!searchReady(env)) throw new IntelligenceError('Configure TAVILY_API_KEY or SERPAPI_API_KEY for live job discovery');
  const trace = diagnostics?.trace;
  let currentSource: DiscoverySourceSummary | undefined;
  const budget = new Budget(Date.now() + 35000, event => {
    trace?.(event);
    if (currentSource && event.stage === 'fetch' && [0, 403, 429, 999].includes(Number(event.status))) currentSource.restricted++;
  },env);
  const results: DiscoveredJob[] = [], seen = new Set<string>();
  const mode = profile.mode === 'internship' ? 'internship' : 'job';
  const roles = strings(profile.target_roles).slice(0, 2), role = roles.join(' OR ') || 'software engineer';
  const location = strings(profile.preferred_locations).slice(0, 2).join(' '), skill = strings(profile.skills)[0] || '';
  const definitions = {
    internshala: { name: 'Internshala', domains: ['internshala.com'] },
    wellfound: { name: 'Wellfound', domains: ['wellfound.com'] },
    greenhouse: { name: 'Greenhouse', domains: ['job-boards.greenhouse.io', 'boards.greenhouse.io'] },
    lever: { name: 'Lever', domains: ['jobs.lever.co', 'jobs.eu.lever.co'] },
    linkedin: { name: 'LinkedIn', domains: ['linkedin.com'] },
    naukri: { name: 'Naukri', domains: ['naukri.com'] },
  };
  const selected: (keyof typeof definitions)[] = mode === 'internship'
    ? ['internshala', 'wellfound', 'greenhouse', 'lever', 'linkedin']
    : ['naukri', 'linkedin', 'greenhouse', 'lever'];
  const pools = selected.map(id => ({ ...definitions[id], summary: { id, name: definitions[id].name, searched: 0, verified: 0, restricted: 0, status: 'empty', search_calls: 0 } as DiscoverySourceSummary, found: [] as SearchResult[], cursor: 0 }));
  const report = () => diagnostics?.report?.(pools.map(pool => ({ ...pool.summary })));
  const query = `${role} ${mode === 'internship' ? 'internship' : 'job'} ${location} ${skill}`.replace(/\s+/g, ' ').trim();
  trace?.({ stage: 'profile', mode, role_count: roles.length, skill_count: strings(profile.skills).length, location_count: strings(profile.preferred_locations).length });
  // Each portal gets its own actual provider request. Start every source before
  // checking details so a successful first portal cannot prevent other searches.
  const searched = await Promise.allSettled(pools.map(async pool => {
    if (budget.exhausted) { pool.summary.status = 'budget_limited'; return; }
    pool.summary.search_calls = 1;
    const found = await search(env, query, budget, false, true, pool.domains, 4);
    // Provider domain filters are advisory. Enforce attribution locally too.
    pool.found = found.filter(result => {
      try { const host = new URL(result.url).hostname.toLowerCase(); return pool.domains.some(domain => host === domain || host.endsWith(`.${domain}`)); }
      catch { return false; }
    });
    pool.summary.searched = pool.found.length;
    trace?.({ stage: 'search', source: pool.summary.id, result_count: pool.found.length, search_calls: 1 });
  }));
  for (let index = 0; index < searched.length; index++) {
    if (searched[index].status === 'rejected') {
      pools[index].summary.status = 'unavailable';
      diagnostics?.warn(`${pools[index].name} could not be searched. Results from other available sources are shown.`);
      trace?.({ stage: 'search', source: pools[index].summary.id, result_count: 0, search_calls: pools[index].summary.search_calls, unavailable: true });
    }
  }
  if (searched.every(result => result.status === 'rejected')) {
    report();
    throw (searched.find(result => result.status === 'rejected') as PromiseRejectedResult).reason;
  }
  let skipped = 0;
  // Advance one candidate per source per pass. Invalid, expired or restricted
  // details do not let another portal monopolize the first verified slots.
  while (results.length < 8 && !budget.exhausted && pools.some(pool => pool.cursor < pool.found.length)) {
    for (const pool of pools) {
      if (results.length >= 8 || budget.exhausted) break;
      const result = pool.found[pool.cursor++]; if (!result) continue;
      const url = listingUrl(result.url);
      if (!url || seen.has(listingIdentity(url))) { skipped++; continue; }
      seen.add(listingIdentity(url));
      if (mode === 'internship' && /\b(senior|principal|staff|lead|director|manager)\b/i.test(result.title) && !/\b(intern(?:ship)?|trainee|apprentice)\b/i.test(result.title)) { skipped++; continue; }
      currentSource = pool.summary; const restrictedBefore = pool.summary.restricted;
      try {
        const job = await listingDetails(result, url, budget, trace,env);
        const host = job ? new URL(job.url).hostname.toLowerCase() : '';
        // A redirect to another portal is not a verified listing from this one.
        if (!job || !pool.domains.some(domain => host === domain || host.endsWith(`.${domain}`)) || job.listing_type !== mode || results.some(value => listingIdentity(value.url) === listingIdentity(job.url))) { skipped++; continue; }
        results.push(job); pool.summary.verified++;
      } catch {
        skipped++;
        if (!budget.exhausted && pool.summary.restricted === restrictedBefore) pool.summary.restricted++;
      } finally { currentSource = undefined; }
    }
  }
  for (const pool of pools) {
    if (pool.summary.status === 'unavailable' || pool.summary.status === 'budget_limited' && !pool.summary.search_calls) continue;
    pool.summary.status = budget.exhausted && pool.cursor < pool.found.length ? 'budget_limited'
      : pool.summary.verified ? 'ok' : pool.summary.restricted ? 'restricted' : 'empty';
  }
  if (budget.exhausted) diagnostics?.warn('The search time or request limit was reached. Verified opportunities found so far are shown.');
  if (!results.length) diagnostics?.warn('No active individual listings could be verified. Try a broader target role or location, or paste a current job-detail URL and its description.');
  else if (skipped) diagnostics?.warn('Expired roles, search pages, duplicates, and pages blocked by job sites were omitted.');
  const searchResults = pools.reduce((total, pool) => total + pool.summary.searched, 0);
  trace?.({ stage: 'summary', search_results: searchResults, unique_candidates: seen.size, verified: results.length, skipped, requests: budget.used });
  report();
  return results;
}

/** Bounded primitives for resumable Queue cycles; each call has its own deadline. */
export async function searchDiscoveryPage(env:Env,query:string,domains:string[],maximum=10){
 const budget=new Budget(Date.now()+15000,undefined,env);
 return search(env,query,budget,false,true,domains,Math.min(20,Math.max(1,maximum)));
}
export async function verifyDiscoveryDetail(env:Env,candidate:{url:string;title:string;company?:string;location?:string},trace?:(data:DiscoveryTrace)=>void){
 const url=listingUrl(candidate.url);if(!url)return null;
 return listingDetails({...candidate,content:''},url,new Budget(Date.now()+20000,trace,env),trace,env);
}
export const discoveryCanonicalIdentity=(raw:string)=>{const url=listingUrl(raw);return url?listingIdentity(url):null;};
