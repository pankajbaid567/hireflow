import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';
import { buildPrepGuide, discoverJobs, extractProfile, extractSkills, generateText, scoreMatch } from '../src/intelligence';

const env = (values: Record<string, any> = {}): Env => values as Env;
const reply = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const mockFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>) => {
  const mock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => handler(String(input), init));
  vi.stubGlobal('fetch', mock); return mock;
};
const pdf = new TextEncoder().encode('%PDF-1.4\nSynthetic test resume');
const generatedQuestions = [
  { category: 'technical', question: 'How would you test a Python service?' },
  { category: 'behavioral', question: 'Describe a project and its feedback.' },
  { category: 'design', question: 'Sketch a Python API and its data flow.' },
];
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('portable matching', () => {
  it('compares explicit INR annual and monthly salaries against the job-mode minimum', () => {
    const user={skills:['Python'],mode:'job',min_salary:1200000};
    const job={title:'Python Engineer',description:'Python. Salary INR 8-15 LPA.',listing_type:'job'};
    const high=scoreMatch(user,job).score;
    expect(scoreMatch(user,{...job,description:'Python. Salary INR 4 LPA.'}).score).toBeLessThan(high);
    expect(scoreMatch(user,{...job,description:'Python. Salary INR 100,000 per month.'}).score).toBeGreaterThan(high); // Guaranteed preference vs overlapping range.
    expect(scoreMatch(user,{...job,description:'Python. Salary USD 30,000 per year.'}).score).toBeLessThan(high);
  });
  it('extracts aliases and language boundaries without Java/JavaScript or C++/C# collisions', () => {
    expect(extractSkills('JavaScript, TS, NodeJS, postgres, k8s, C++ and golang')).toEqual(['JavaScript', 'TypeScript', 'Go', 'C++', 'Node.js', 'Kubernetes', 'PostgreSQL']);
    expect(extractSkills('go above and beyond; an ongoing project')).not.toContain('Go');
    expect(extractSkills('C# and Java')).toEqual(['Java', 'C#']);
  });
  it('uses the shared weighted score and ranks the stronger candidate first', () => {
    const job = { title: 'AI Engineer Intern', description: 'Python LangChain Docker RAG', company: 'Acme', listing_type: 'internship', location: 'Remote' };
    const best = scoreMatch({ skills: ['Python', 'LangChain', 'Docker', 'RAG'], mode: 'internship', target_roles: ['AI Engineer'], preferred_locations: ['Remote'] }, job);
    const partial = scoreMatch({ skills: ['Python', 'LangChain'] }, job);
    expect(best.score).toBeCloseTo(0.925, 4); // Undisclosed pay and employer signal stay neutral.
    expect(best.score).toBeGreaterThan(partial.score);
    expect(partial.gaps).toEqual(['RAG', 'Docker']);
    expect(partial.matched).toEqual(['Python', 'LangChain']);
  });
  it('handles empty/malformed optional profile fields with a finite bounded score', () => {
    const result = scoreMatch({ skills: null, experience: null, preferred_locations: null }, { title: 'Assistant', description: '' });
    expect(Number.isFinite(result.score)).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(0); expect(result.score).toBeLessThanOrEqual(1);
    expect(result.skills).toEqual([]);
  });
  it('recognizes a profile-specific skill and does not invent a stipend from round/year numbers', () => {
    const profile = { skills: ['Elixir'], min_stipend: 10000, mode: 'internship' };
    const job = { title: 'Intern', description: 'Elixir. Two rounds in 2026.', listing_type: 'internship' };
    const baseline = scoreMatch(profile, job);
    expect(baseline.matched).toEqual(['Elixir']);
    expect(scoreMatch(profile, { ...job, description: 'Elixir stipend INR 20,000 per month.' }).score).toBeGreaterThan(baseline.score);
  });
  it('matches custom skills in one bounded scan while retaining literal boundaries and case deduplication', () => {
    const result = scoreMatch({ skills: ['Python', 'Elixir', 'ELIXIR', 'Nx+', 'Nx++', 'custom.skill'] }, { title: 'Engineer', description: 'Python Elixir and Nx++. custom.skillful is not the custom.skill requirement.' });
    expect(result.skills).toEqual(['Python', 'ELIXIR', 'Nx++', 'custom.skill']);
    expect(result.gaps).toEqual([]); expect(result.matched).not.toContain('Nx+');
    // A previous call must not leave a global regex cursor behind in warm Workers.
    expect(scoreMatch({ skills: ['Elixir'] }, { title: 'Engineer', description: 'Elixir' }).matched).toEqual(['Elixir']);
  });
});

describe('bounded REST providers', () => {
  it('shares a 15-second generation deadline across response headers and body consumption',async()=>{
    vi.useFakeTimers();
    mockFetch((_url,init)=>new Promise(resolve=>setTimeout(()=>{
      const response=reply({});
      Object.defineProperty(response,'json',{value:()=>new Promise((_done,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('private body timeout')),{once:true}))});
      resolve(response);
    },14000)));
    const assertion=expect(generateText(env({GROQ_API_KEY:'test-key'}),'synthetic timeout fixture')).rejects.toMatchObject({provider_failure:{kind:'timeout'}});
    await vi.advanceTimersByTimeAsync(15000);await assertion;expect(vi.getTimerCount()).toBe(0);
  });
  it('calls Groq with the verified model, header-only credentials and bounded output', async () => {
    const fetch = mockFetch((url, init) => {
      expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-test-key');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('openai/gpt-oss-20b'); expect(body.max_completion_tokens).toBe(4096);
      expect(body.messages[0].content).toBe('Test prompt');
      return reply({ choices: [{ message: { content: '  An answer  ' } }] });
    });
    expect(await generateText(env({ GROQ_API_KEY: 'secret-test-key' }), 'Test prompt')).toBe('An answer');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('uses Gemini Interactions and extracts only model text, retaining the selected model', async () => {
    mockFetch((url, init) => {
      expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('preferred-key');
      const body = JSON.parse(String(init.body));
      expect(body).toMatchObject({ model: 'gemini-3.8-flash', store: false, generation_config: { max_output_tokens: 4096 } });
      return reply({ status: 'completed', steps: [
        { type: 'user_input', content: [{ type: 'text', text: 'Private input' }] },
        { type: 'model_output', content: [{ type: 'thought', text: 'Do not expose thoughts' }, { type: 'text', text: 'A Gemini answer' }] },
      ] });
    });
    expect(await generateText(env({ LLM_PROVIDER: 'gemini', GEMINI_MODEL: 'models/gemini-3.8-flash', GEMINI_API_KEY: 'preferred-key', GOOGLE_API_KEY: 'legacy-key' }), 'test')).toBe('A Gemini answer');
  });
  it('accepts the legacy Gemini key when the preferred key is a placeholder', async () => {
    mockFetch((_, init) => {
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('legacy-key');
      return reply({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'OK' }] }] });
    });
    expect(await generateText(env({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'your_key', GOOGLE_API_KEY: 'legacy-key' }), 'test')).toBe('OK');
  });
  it('reports missing or unsupported configuration without any network call', async () => {
    const fetch = mockFetch(() => { throw new Error('No network expected'); });
    await expect(generateText(env(), 'test')).rejects.toThrow('GROQ_API_KEY is required');
    await expect(generateText(env({ LLM_PROVIDER: 'gemini' }), 'test')).rejects.toThrow('GEMINI_API_KEY or GOOGLE_API_KEY');
    await expect(generateText(env({ LLM_PROVIDER: 'unsupported' }), 'test')).rejects.toThrow('groq or gemini');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('never echoes provider error bodies, request URLs or keys', async () => {
    mockFetch(() => reply({ error: 'secret-test-key in sensitive provider body' }, 503));
    await expect(generateText(env({ GROQ_API_KEY: 'secret-test-key' }), 'test')).rejects.toThrow('Groq request failed (HTTP 503)');
    try { await generateText(env({ GROQ_API_KEY: 'secret-test-key' }), 'test'); } catch (error) {
      expect(String(error)).not.toContain('secret-test-key'); expect(String(error)).not.toContain('sensitive provider body');
    }
    mockFetch(() => { throw new Error('https://example.com/?key=secret-test-key'); });
    await expect(generateText(env({ GROQ_API_KEY: 'secret-test-key' }), 'test')).rejects.toThrow('External service request failed or timed out');
  });
  it('rejects incomplete Gemini interactions and empty Groq responses', async () => {
    mockFetch(() => reply({ status: 'incomplete', steps: [] }));
    await expect(generateText(env({ LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key' }), 'test')).rejects.toThrow('did not complete');
    mockFetch(() => reply({ choices: [{ message: { content: '' } }] }));
    await expect(generateText(env({ GROQ_API_KEY: 'test-key' }), 'test')).rejects.toThrow('no answer text');
  });
});

describe('PDF-only profile extraction', () => {
  it('sends Gemini inline PDF data without a native PDF dependency and validates profile facts', async () => {
    mockFetch((url, init) => {
      expect(url).toContain('/models/gemini-3.8-flash:generateContent'); expect(url).not.toContain('test-key');
      const body = JSON.parse(String(init.body));
      const inline = body.contents[0].parts[1].inlineData;
      expect(inline.mimeType).toBe('application/pdf'); expect(atob(inline.data)).toContain('%PDF-');
      expect(body.generationConfig.maxOutputTokens).toBe(4096);
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Test Candidate', email: 'test@example.com', skills: ['JS', 'Postgres'], mode: 'internship', weekly_quota: 2, experience: [], education: [] }) }] } }] });
    });
    const result = await extractProfile(env({ LLM_PROVIDER: 'groq', GEMINI_API_KEY: 'test-key' }), pdf);
    expect(result).toMatchObject({ name: 'Test Candidate', email: 'test@example.com', skills: ['JavaScript', 'PostgreSQL'], weekly_quota: 2, mode: 'internship', projects: [], experience_years: 0 });
  });
  it('requires explicit Gemini configuration and rejects invalid/oversized PDFs before fetch', async () => {
    const fetch = mockFetch(() => reply({}));
    await expect(extractProfile(env({ GROQ_API_KEY: 'test-key' }), pdf)).rejects.toThrow('requires GEMINI_API_KEY');
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), new TextEncoder().encode('not a PDF'))).rejects.toThrow('valid PDF');
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toThrow('up to 5 MB');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('fails cleanly for malformed JSON or missing real identity fields', async () => {
    mockFetch(() => reply({ candidates: [{ content: { parts: [{ text: 'not JSON' }] } }] }));
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), pdf)).rejects.toThrow('invalid JSON');
    mockFetch(() => reply({ candidates: [{ content: { parts: [{ text: '{"name":"Test","skills":[]}' }] } }] }));
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), pdf)).rejects.toThrow('identifiable name and email');
  });
  const largePdf = (): Uint8Array => { const value = new Uint8Array(32769); value.set(pdf); return value; };
  const extracted = () => reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ name: 'Test Candidate', email: 'test@example.com', phone: '1234', skills: ['Python'], is_admin: true }) }] } }] });
  it('uploads larger PDFs as raw bytes, uses their private file reference and deletes them after extraction', async () => {
    const input = largePdf(); let fileName = '', fileUrl = '';
    const base64 = vi.spyOn(globalThis, 'btoa');
    const fetch = mockFetch((url, init) => {
      expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key');
      expect(init.redirect).toBe('manual');
      if (url.endsWith('/upload/v1beta/files')) {
        const metadata = JSON.parse(String(init.body)); fileName = metadata.file.name; fileUrl = `https://generativelanguage.googleapis.com/v1beta/${fileName}`;
        expect(fileName).toMatch(/^files\/hf-[a-f0-9]{32}$/); expect(fileName.slice('files/'.length).length).toBeLessThanOrEqual(40);
        expect(metadata.file.display_name).toBe('hireflow-resume.pdf');
        expect(init.headers).toMatchObject({ 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Header-Content-Length': '32769' });
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=private-token' } });
      }
      if (url.includes('upload_id=')) {
        expect(init.body).toBe(input); expect(init.headers).toMatchObject({ 'X-Goog-Upload-Command': 'upload, finalize', 'X-Goog-Upload-Offset': '0' });
        return reply({ file: { name: fileName, uri: fileUrl, state: 'ACTIVE' } });
      }
      if (init.method === 'DELETE') { expect(url).toBe(fileUrl); return new Response(null, { status: 204 }); }
      const body = JSON.parse(String(init.body));
      expect(body.contents[0].parts[1]).toEqual({ fileData: { mimeType: 'application/pdf', fileUri: fileUrl } });
      expect(body.contents[0].parts[1]).not.toHaveProperty('inlineData');
      return extracted();
    });
    const profile = await extractProfile(env({ GEMINI_API_KEY: 'test-key' }), input);
    expect(profile).toMatchObject({ phone: '1234', skills: ['Python'] }); expect(profile).not.toHaveProperty('is_admin');
    expect(fetch).toHaveBeenCalledTimes(4); expect(fetch.mock.calls[3]?.[1]?.method).toBe('DELETE'); expect(base64).not.toHaveBeenCalled();
  });
  it.each(['https://attacker.example/upload/', 'http://generativelanguage.googleapis.com/upload/', 'https://user:password@generativelanguage.googleapis.com/upload/', 'https://generativelanguage.googleapis.com:8443/upload/', 'https://generativelanguage.googleapis.com/v1beta/files'])('rejects an untrusted upload destination before sending credentials or PDF bytes: %s', async uploadUrl => {
    const fetch = mockFetch((url, init) => {
      if (init.method === 'DELETE') return new Response(null, { status: 404 });
      expect(url).toBe('https://generativelanguage.googleapis.com/upload/v1beta/files');
      return new Response(null, { headers: { 'X-Goog-Upload-URL': uploadUrl } });
    });
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf())).rejects.toThrow('invalid upload destination');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('preserves a failed initialization status without attempting to delete a file that was never uploaded', async () => {
    const fetch = mockFetch(() => reply({ error: 'private provider body test-key' }, 400));
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf())).rejects.toThrow('Gemini PDF upload request failed (HTTP 400)');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('validates and cleans up the actual file ID returned by the service', async () => {
    const actualUrl = 'https://generativelanguage.googleapis.com/v1beta/files/server-assigned-id';
    const fetch = mockFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
      if (url.includes('upload_id=')) return reply({ file: { name: 'files/server-assigned-id', uri: actualUrl, state: 'ACTIVE' } });
      if (init.method === 'DELETE') { expect(url).toBe(actualUrl); return new Response(null, { status: 204 }); }
      expect(JSON.parse(String(init.body)).contents[0].parts[1].fileData.fileUri).toBe(actualUrl);
      return extracted();
    });
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf())).resolves.toMatchObject({ name: 'Test Candidate' });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it.each(['provider', 'identity', 'json'])('deletes the uploaded PDF when %s extraction fails', async failure => {
    vi.useFakeTimers();
    let fileName = '';
    const fetch = mockFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) {
        fileName = JSON.parse(String(init.body)).file.name;
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
      }
      if (url.includes('upload_id=')) return reply({ file: { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'ACTIVE' } });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return failure === 'provider' ? reply({ error: 'test-key private body' }, 503) : reply({ candidates: [{ content: { parts: [{ text: failure === 'json' ? 'invalid JSON' : '{}' }] } }] });
    });
    const assertion = expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf())).rejects.toThrow(failure === 'provider' ? 'HTTP 503' : failure === 'json' ? 'invalid JSON' : 'identifiable name and email');
    await vi.advanceTimersByTimeAsync(3000); await assertion;
    expect(fetch).toHaveBeenCalledTimes(failure === 'provider' ? 5 : 4); expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });
  it('cleans up the known file ID when finalization fails before returning its response', async () => {
    let fileName = '';
    const fetch = mockFetch((url, init) => {
      if (init.method === 'DELETE') { expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/${fileName}`); return new Response(null, { status: 404 }); }
      if (url.includes('upload_id=')) throw new Error('private-upload-token secret-test-key');
      fileName = JSON.parse(String(init.body)).file.name;
      return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
    });
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf())).rejects.toThrow('External service request failed or timed out');
    expect(fetch).toHaveBeenCalledTimes(3); expect(fetch.mock.calls[2]?.[1]?.method).toBe('DELETE');
  });
  it.each([true, false])('bounds PROCESSING polling and always deletes the remote file (becomes active: %s)', async becomesActive => {
    vi.useFakeTimers(); let fileName = '', polls = 0;
    const fetch = mockFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) {
        fileName = JSON.parse(String(init.body)).file.name;
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
      }
      const file = { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'PROCESSING' };
      if (url.includes('upload_id=')) return reply({ file });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (!init.method) { polls += 1; return reply({ ...file, state: becomesActive ? 'ACTIVE' : 'PROCESSING' }); }
      return extracted();
    });
    const result = extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf());
    const assertion = becomesActive ? expect(result).resolves.toMatchObject({ name: 'Test Candidate' }) : expect(result).rejects.toThrow('not ready for extraction');
    await vi.advanceTimersByTimeAsync(4000); await assertion;
    expect(polls).toBe(becomesActive ? 1 : 3); expect(fetch.mock.calls.length).toBe(becomesActive ? 5 : 6);
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
  });
  it('reports cleanup failures without exposing file IDs, keys or provider responses', async () => {
    let fileName = '';
    mockFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) {
        fileName = JSON.parse(String(init.body)).file.name;
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
      }
      if (url.includes('upload_id=')) return reply({ file: { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'ACTIVE' } });
      if (init.method === 'DELETE') return reply({ error: 'secret-test-key private body' }, 503);
      return extracted();
    });
    try { await extractProfile(env({ GEMINI_API_KEY: 'test-key' }), largePdf()); throw new Error('Expected a cleanup failure'); } catch (error) {
      expect(String(error)).toContain('cleanup could not be confirmed'); expect(String(error)).not.toContain(fileName);
      expect(String(error)).not.toContain('secret-test-key'); expect(String(error)).not.toContain('private body');
    }
  });
  it('reserves cleanup time and caps the entire multi-request operation at 45 seconds', async () => {
    vi.useFakeTimers(); const started = Date.now(); let fileName = '';
    const fetch = mockFetch(async (url, init) => {
      if (url.endsWith('/upload/v1beta/files')) {
        await new Promise(resolve => setTimeout(resolve, 4000)); fileName = JSON.parse(String(init.body)).file.name;
        return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } });
      }
      if (url.includes('upload_id=')) {
        await new Promise(resolve => setTimeout(resolve, 8000));
        return reply({ file: { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'ACTIVE' } });
      }
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private aborted request')), { once: true }));
    });
    const assertion = expect(extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), largePdf())).rejects.toThrow('cleanup could not be confirmed');
    await vi.advanceTimersByTimeAsync(45000); await assertion;
    expect(Date.now() - started).toBe(45000); expect(fetch).toHaveBeenCalledTimes(6); expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe('DELETE');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retries a transient primary failure on the same requested model and records only safe status metadata', async () => {
    vi.useFakeTimers(); let attempts = 0;
    const fetch = mockFetch(() => ++attempts === 1 ? reply({ error: 'private applicant body secret-test-key' }, 503) : extracted());
    const result = extractProfile(env({ GEMINI_API_KEY: 'secret-test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), pdf);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ name: 'Test Candidate', resume_extraction_model: 'gemini-3.8-flash', resume_extraction_fallback_used: false });
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.every(([url]) => String(url).includes('/models/gemini-3.8-flash:generateContent'))).toBe(true);
    const logged = vi.mocked(console.warn).mock.calls.map(call => String(call[0])).join(' ');
    expect(logged).toContain('"status":503'); expect(logged).not.toContain('secret-test-key'); expect(logged).not.toContain('private applicant');
  });
  it('uses only the explicitly configured fallback after two transient primary failures', async () => {
    vi.useFakeTimers(); const models: string[] = [];
    const fetch = mockFetch(url => { models.push(new URL(url).pathname); return models.length < 3 ? reply({}, 503) : extracted(); });
    const result = extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'models/gemini-3.5-flash-lite' }), pdf);
    await vi.advanceTimersByTimeAsync(3000); const profile = await result;
    expect(profile).toMatchObject({ resume_extraction_model: 'gemini-3.5-flash-lite', resume_extraction_fallback_used: true, skills: ['Python'] }); expect(profile).not.toHaveProperty('resume_extraction_warning');
    expect(models).toEqual(['/v1beta/models/gemini-3.8-flash:generateContent', '/v1beta/models/gemini-3.8-flash:generateContent', '/v1beta/models/gemini-3.5-flash-lite:generateContent']); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('does not select any fallback model when the setting is absent', async () => {
    vi.useFakeTimers(); const fetch = mockFetch(() => reply({}, 503));
    const assertion = expect(extractProfile(env({ GEMINI_API_KEY: 'test-key' }), pdf)).rejects.toThrow('HTTP 503');
    await vi.advanceTimersByTimeAsync(1000); await assertion;
    expect(fetch).toHaveBeenCalledTimes(2); expect(fetch.mock.calls.every(([url]) => String(url).includes('gemini-3.8-flash'))).toBe(true);
  });
  it.each([400, 401, 403, 404])('never retries or falls back on permanent HTTP %s', async status => {
    const fetch = mockFetch(() => reply({ error: 'private provider detail' }, status));
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), pdf)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1); expect(console.warn).not.toHaveBeenCalled();
  });
  it('recovers network timeouts without logging the original exception', async () => {
    vi.useFakeTimers(); let attempts = 0;
    const fetch = mockFetch(() => { if (++attempts === 1) throw new Error('https://private.example/?key=secret-test-key'); return extracted(); });
    const result = extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), pdf);
    await vi.advanceTimersByTimeAsync(1000); expect((await result).resume_extraction_fallback_used).toBe(false); expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(console.warn).mock.calls)).not.toContain('secret-test-key');
  });
  it('reuses a large uploaded PDF across recovery and deletes it exactly once', async () => {
    vi.useFakeTimers(); let fileName = '', generations = 0;
    const fetch = mockFetch((url, init) => {
      if (url.endsWith('/upload/v1beta/files')) { fileName = JSON.parse(String(init.body)).file.name; return new Response(null, { headers: { 'X-Goog-Upload-URL': 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=test' } }); }
      if (url.includes('upload_id=')) return reply({ file: { name: fileName, uri: `https://generativelanguage.googleapis.com/v1beta/${fileName}`, state: 'ACTIVE' } });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      const body = JSON.parse(String(init.body)); expect(body.contents[0].parts[1].fileData.fileUri).toBe(`https://generativelanguage.googleapis.com/v1beta/${fileName}`);
      return ++generations < 3 ? reply({}, 503) : extracted();
    });
    const result = extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), largePdf());
    await vi.advanceTimersByTimeAsync(3000); expect((await result).resume_extraction_fallback_used).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(6); expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1); expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/upload/v1beta/files'))).toHaveLength(1);
  });
  it('does not retry malformed successful JSON responses and rejects invalid model configuration before fetching', async () => {
    const fetch = mockFetch(() => new Response('not JSON', { status: 200 }));
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), pdf)).rejects.toThrow('returned an invalid response'); expect(fetch).toHaveBeenCalledTimes(1);
    await expect(extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'https://example.org/private?key=secret' }), pdf)).rejects.toThrow('valid Gemini extraction model IDs'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('retries an aborted response body while treating ordinary malformed JSON as permanent', async () => {
    vi.useFakeTimers(); let attempts = 0;
    const fetch = mockFetch((_, init) => {
      if (++attempts > 1) return extracted();
      const response = reply({});
      Object.defineProperty(response, 'json', { value: () => new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('private body timeout')), { once: true })) });
      return response;
    });
    const result = extractProfile(env({ GEMINI_API_KEY: 'test-key', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash-lite' }), pdf);
    await vi.advanceTimersByTimeAsync(13000);
    expect((await result).resume_extraction_fallback_used).toBe(false); expect(fetch).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('source-backed interview preparation', () => {
  it('returns explicit rounds, strong/related/missing topics and JD-specific fallback questions without providers', async () => {
    const fetch = mockFetch(() => { throw new Error('No network expected'); });
    const guide = await buildPrepGuide(env(), { skills: ['Python', 'JavaScript'] }, { title: 'AI Intern', company: 'Acme', listing_type: 'internship', description: 'Python, FastAPI, TypeScript and Docker. Three rounds: technical, HR and founder.' });
    expect(guide.round_count).toBe(3); expect(guide.rounds.map((r: any) => r.type)).toEqual(['technical', 'HR', 'founder']);
    expect(guide.topics).toEqual({ strong: ['Python'], moderate: ['TypeScript', 'FastAPI'], gaps: ['Docker'] });
    expect(guide.questions[0].question).toContain('Acme'); expect(guide.questions[0].question).toContain('small Python example');
    expect(new Set(guide.questions.map((q: any) => q.category))).toEqual(new Set(['technical', 'behavioral', 'design']));
    expect(guide.resources).toEqual({}); expect(guide.company_intel.recent_news).toEqual([]);
    expect(guide.company_intel.interview_review_status).toBe('No interview reviews found');
    expect(guide.warnings).toHaveLength(2); expect(fetch).not.toHaveBeenCalled();
  });
  it('uses lighter internship defaults and company-stage-sensitive full-time rounds', async () => {
    const intern = await buildPrepGuide(env(), {}, { title: 'Python Intern', listing_type: 'internship', company_stage: 'startup', description: 'Python' });
    const full = await buildPrepGuide(env(), {}, { title: 'Engineer', listing_type: 'job', company_stage: 'public company', description: 'Python' });
    expect(intern.round_count).toBe(2); expect(intern.rounds[1].type).toBe('founder'); expect(full.round_count).toBe(4);
    expect(intern.questions[0].question).toContain('small'); expect(full.questions[0].question).toContain('production');
  });
  it('uses valid generated questions and distinguishes configured provider errors from missing credentials', async () => {
    mockFetch(() => reply({ choices: [{ message: { content: JSON.stringify(generatedQuestions) } }] }));
    const generated = await buildPrepGuide(env({ GROQ_API_KEY: 'test-key' }), {}, { title: 'Python Engineer', description: 'Python APIs', company: 'Acme' });
    expect(generated.questions).toEqual(generatedQuestions);
    mockFetch(() => reply({ message: 'test-key secret failure body' }, 503));
    const failed = await buildPrepGuide(env({ GROQ_API_KEY: 'test-key' }), {}, { title: 'Python Engineer', description: 'Python APIs' });
    expect(failed.warnings.join(' ')).toContain('Question generation unavailable: Groq request failed (HTTP 503)');
    expect(failed.warnings.join(' ')).not.toContain('test-key'); expect(failed.warnings.join(' ')).not.toContain('LLM provider is not configured');
    expect(failed.questions[0].question).toContain('Python');
  });
  it('rejects generic/malformed LLM questions and retains useful deterministic guidance', async () => {
    mockFetch(() => reply({ choices: [{ message: { content: JSON.stringify(generatedQuestions.map(q => ({ ...q, question: 'A generic question?' }))) } }] }));
    const guide = await buildPrepGuide(env({ GROQ_API_KEY: 'test-key' }), {}, { title: 'Python Engineer', company: 'Acme', description: 'Python data pipelines' });
    expect(guide.warnings.join(' ')).toContain('invalid interview questions'); expect(guide.questions[0].question).toContain('Python data pipelines');
  });
  it('skips inaccessible links, finds alternatives and preserves citations with dated news/review evidence', async () => {
    const recent = new Date(Date.now() - 3 * 86400000).toISOString(), old = new Date(Date.now() - 200 * 86400000).toISOString();
    mockFetch((url, init) => {
      if (url === 'https://api.tavily.com/search') {
        const { query } = JSON.parse(String(init.body));
        if (query.includes('official documentation')) return reply({ results: [
          { title: 'Broken', url: 'https://docs.example.com/broken' }, { title: 'Guide', url: 'https://docs.example.com/guide' },
          { title: 'Tutorial', url: 'https://docs.example.com/tutorial' }, { title: 'Alternative', url: 'https://docs.example.com/alternative' },
        ] });
        if (query.includes('recent news')) return reply({ results: [
          { title: 'Recent launch', url: 'https://news.example.com/recent', content: 'A source-backed launch', published_date: recent },
          { title: 'Too old', url: 'https://news.example.com/old', published_date: old }, { title: 'Undated', url: 'https://news.example.com/undated' },
        ] });
        if (query.includes('Glassdoor')) return reply({ results: [
          { title: 'Blocked interview', url: 'https://www.glassdoor.com/Interview/acme.htm', content: 'Blocked reviews' },
          { title: 'Candidate report', url: 'https://www.ambitionbox.com/interviews/acme-interview-questions', content: 'Candidate described two technical rounds.' },
        ] });
        return reply({ results: [{ title: 'About Acme', url: 'https://company.example.com/about', content: 'A seed company with 42 employees building Python services.' }] });
      }
      if (url.endsWith('/broken') || url.includes('glassdoor.com')) return new Response(null, { status: 403 });
      if (url.endsWith('/tutorial') && init.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response(null, { status: 200 });
    });
    const guide = await buildPrepGuide(env({ TAVILY_API_KEY: 'test-key' }), {}, { title: 'Python Engineer', company: 'Acme', description: 'Python' });
    expect(guide.resources.Python.map((r: any) => r.title)).toEqual(['Guide', 'Tutorial', 'Alternative']);
    expect(guide.company_intel.stage).toBe('seed'); expect(guide.company_intel.team_size).toBe('42');
    expect(guide.company_intel.tech_stack).toEqual(['Python']); expect(guide.company_intel.recent_news).toHaveLength(1);
    expect(guide.company_intel.recent_news[0].url).toBe('https://news.example.com/recent');
    expect(guide.company_intel.interview_patterns).toHaveLength(1); expect(guide.company_intel.sources.length).toBeGreaterThan(0);
  });
  it('caps research plus LLM calls at 25 even when source redirects consume the budget', async () => {
    const fetch = mockFetch((url) => {
      if (url.includes('api.groq.com')) return reply({ choices: [{ message: { content: JSON.stringify(generatedQuestions) } }] });
      if (url.includes('api.tavily.com')) return reply({ results: Array.from({ length: 6 }, (_, i) => ({ title: `Result ${i}`, url: `https://docs.example.com/${i}` })) });
      return new Response(null, { status: 302, headers: { Location: '/redirect' } });
    });
    const guide = await buildPrepGuide(env({ GROQ_API_KEY: 'test-key', TAVILY_API_KEY: 'test-key' }), {}, { title: 'Engineer', description: 'Python Docker TypeScript RAG Rust AWS', company: 'Acme' });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(25); expect(Object.keys(guide.resources)).toHaveLength(3);
    expect(guide.warnings.join(' ')).toContain('budget reached');
  });
  it('blocks private source URLs and redirects before fetching an internal destination', async () => {
    const fetch = mockFetch((url) => {
      if (url.includes('api.tavily.com')) return reply({ results: [
        { title: 'Private', url: 'http://127.0.0.1/resource' }, { title: 'Metadata', url: 'http://169.254.169.254/latest' },
        { title: 'Redirect', url: 'https://docs.example.com/redirect' },
      ] });
      return new Response(null, { status: 302, headers: { Location: 'http://10.0.0.1/private' } });
    });
    const guide = await buildPrepGuide(env({ TAVILY_API_KEY: 'test-key' }), {}, { title: 'Python Engineer', description: 'Python' });
    expect(guide.resources.Python).toEqual([]);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('127.0.0.1') && !String(url).includes('169.254.169.254') && !String(url).includes('10.0.0.1'))).toBe(true);
  });
});

describe('live-source job discovery', () => {
  it('returns only accessible source listings matching the selected mode, with deduplication', async () => {
    const posted = new Date(Date.now() - 2 * 86400000).toISOString();
    const description = 'Build Python internship services with RAG. Work with the team on testable data ingestion, APIs, evaluations, and documentation. Learn through code review and a small production project.';
    const fetch = mockFetch((url, init) => {
      if (url.includes('api.tavily.com')) {
        expect(JSON.parse(String(init.body)).query).toContain('internship');
        return reply({ results: [
          { title: 'AI Intern at Acme', url: 'https://jobs.lever.co/acme/123', content: 'Python internship with RAG.', published_date: posted },
          { title: 'AI Intern at Acme', url: 'https://jobs.lever.co/acme/123#apply', content: 'Python internship.' },
          { title: 'Senior Engineer at Other', url: 'https://boards.greenhouse.io/other/jobs/456', content: 'Full-time Python engineer.' },
          { title: 'Intern search results', url: 'https://example.com/jobs', content: 'Internship directory' },
          { title: 'Blocked Intern at Other', url: 'https://example.com/jobs/blocked', content: 'Internship' },
        ] });
      }
      if(url.startsWith('https://api.lever.co/')) return reply({text:'AI Intern',descriptionPlain:description,categories:{commitment:'Internship'},createdAt:Date.parse(posted)});
      return new Response(null, { status: url.endsWith('/blocked') ? 404 : 200 });
    });
    const jobs = await discoverJobs(env({ TAVILY_API_KEY: 'test-key' }), { mode: 'internship', skills: ['Python'], target_roles: ['AI Engineer', 'ML Engineer'] });
    expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ title: 'AI Intern', company: 'Acme', url: 'https://jobs.lever.co/acme/123', description, listing_type: 'internship', posted_date: posted });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(24);
  });
  it('uses SerpAPI when configured and does not fabricate listings from empty results', async () => {
    mockFetch((url) => { expect(url).toContain('https://serpapi.com/search.json?'); return reply({ organic_results: [] }); });
    expect(await discoverJobs(env({ SERPAPI_API_KEY: 'test-key' }), { mode: 'job' })).toEqual([]);
  });
  it('reports missing search credentials and sanitizes provider failures', async () => {
    const fetch = mockFetch(() => reply({ error: 'secret-test-key' }, 401));
    await expect(discoverJobs(env(), {})).rejects.toThrow('Configure TAVILY_API_KEY or SERPAPI_API_KEY'); expect(fetch).not.toHaveBeenCalled();
    await expect(discoverJobs(env({ SERPAPI_API_KEY: 'secret-test-key' }), {})).rejects.toThrow('Search provider request failed (HTTP 401)');
  });
});
