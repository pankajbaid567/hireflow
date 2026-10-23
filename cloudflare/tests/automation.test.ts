import { readFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import type { Env } from '../src/types';
import type { AutomationCheckpoint, AutomationCheckpointStore } from '../src/automation_checkpoints';

const remote = vi.hoisted(() => ({ launch: vi.fn() }));
const nativeFetch = globalThis.fetch;
vi.mock('@cloudflare/playwright', () => ({ launch: remote.launch }));
import { fillApplication, validatePublicUrl, type ApplicationInput } from '../src/automation';

const origin = 'https://careers.hireflow.example';
const env = { BROWSER: { fetch: vi.fn() } } as unknown as Env;
const profile = { name: 'Test User', email: 'test@example.com', phone: '9999999999', education: 'BTech', experience_years: 0, skills: ['Python', 'FastAPI', 'LangChain'] };
const input = (overrides: Partial<ApplicationInput> = {}): ApplicationInput => ({
  applicationUrl: `${origin}/sample`, profile, resume: Buffer.from('%PDF-1.4\nFixture resume'),
  resumeName: 'test_resume.pdf', jdText: 'Python, FastAPI and LangChain AI Engineer Intern',
  approvedAnswers: { 'why do you want to work here': 'I want to build reliable Python agents with FastAPI and LangChain.' },
  reviewBinding: 'reviewed-fixture-fingerprint', beforeFinalSubmit: async () => true, ...overrides,
});
const sample = readFileSync(new URL('../../tests/fixtures/sample_form.html', import.meta.url), 'utf8');
const flaky = readFileSync(new URL('../../tests/fixtures/flaky_form.html', import.meta.url), 'utf8');
const captchaForm = readFileSync(new URL('../../tests/fixtures/captcha_form.html', import.meta.url), 'utf8');
const manual = readFileSync(new URL('../../tests/fixtures/manual_action_form.html', import.meta.url), 'utf8');
const nativeForm = `<form method="post" action="/submit" enctype="multipart/form-data">
  <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
  <label>Resume<input name="resume" type="file" required></label><button type="submit">Apply</button></form>`;
const multiRoutes = () => Object.fromEntries(['contact','background','documents','review'].map(step => [`/multi/${step}`,readFileSync(new URL(`./fixtures/multistep_${step}.html`,import.meta.url),'utf8')])) as Record<string,string|FixtureResponse>;
function memoryCheckpoint(initial: AutomationCheckpoint | null = null) {
  let value = initial;
  const saved: AutomationCheckpoint[] = [];
  const store: AutomationCheckpointStore = { async load() { return value ? structuredClone(value) : null; }, async save(next) { value=structuredClone(next); saved.push(structuredClone(next)); } };
  return { store,saved,get value() {return value;} };
}

beforeEach(() => { remote.launch.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('public application URL validation', () => {
  it.each([
    'file:///etc/passwd', 'data:text/html,test', 'javascript:alert(1)', 'ftp://example.com/x',
    'https://user:password@example.com/', 'http://localhost/', 'http://localhost./',
    'http://job.local/', 'http://metadata.google.internal/', 'http://private.internal/',
    'http://127.0.0.1/', 'http://127.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://10.1.2.3/', 'http://172.20.0.1/', 'http://192.168.1.1/', 'http://169.254.169.254/',
    'http://100.100.100.200/', 'http://198.18.0.1/', 'http://0.0.0.0/', 'http://224.1.1.1/',
    'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fc00::1]/', 'http://[fe80::1]/',
  ])('rejects %s', url => { expect(() => validatePublicUrl(url)).toThrow('Unsafe application URL'); });

  it.each(['https://jobs.example.com/apply?id=1', 'http://8.8.8.8/apply', 'https://[2606:4700:4700::1111]/'])('allows public URL %s', url => {
    expect(validatePublicUrl(url)).toBe(new URL(url).toString());
  });

  it('removes fragments and rejects an unsafe destination before acquiring a browser', async () => {
    expect(validatePublicUrl('https://jobs.example.com/apply#section')).toBe('https://jobs.example.com/apply');
    const result = await fillApplication(input({ applicationUrl: 'http://127.0.0.1/private' }), env);
    expect(result).toMatchObject({ status: 'failed', submitted: false, retryable: false });
    expect(remote.launch).not.toHaveBeenCalled();
  });
});

describe('attempt lifecycle and budget', () => {
  it('returns a retryable clean failure when browser acquisition fails', async () => {
    remote.launch.mockRejectedValue(new Error('network unavailable'));
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', submitted: false, retryable: true, reason: 'Temporary browser or network failure' });
  });

  it('rejects invalid PDF bytes without opening a browser', async () => {
    expect(await fillApplication(input({ resume: Buffer.from('not a PDF') }), env)).toMatchObject({ status: 'failed', retryable: false, reason: 'Resume must be a PDF' });
    expect(remote.launch).not.toHaveBeenCalled();
  });

  it('bounds acquisition and closes a browser that arrives after the deadline', async () => {
    vi.useFakeTimers();
    let resolve!: (value: any) => void;
    remote.launch.mockImplementation(() => new Promise(value => { resolve = value; }));
    const pending = fillApplication(input(), env);
    await vi.advanceTimersByTimeAsync(42000);
    expect(await pending).toMatchObject({ status: 'failed', retryable: true, submitted: false, reason: 'Browser time budget exceeded' });
    const browser = { close: vi.fn().mockResolvedValue(undefined) };
    resolve(browser);
    await Promise.resolve(); await Promise.resolve();
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('bounds a stalled close to two seconds without losing the result', async () => {
    vi.useFakeTimers();
    const browser = { newContext: vi.fn().mockRejectedValue(new Error('browser disconnected')), close: vi.fn(() => new Promise(() => {})) };
    remote.launch.mockResolvedValue(browser);
    const pending = fillApplication(input(), env);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ status: 'failed', retryable: true, submitted: false });
    expect(browser.close).toHaveBeenCalledOnce();
  });

  it('includes durable checkpoint loading in the browser time budget', async () => {
    vi.useFakeTimers();
    const load = vi.fn(() => new Promise<never>(() => {}));
    const pending = fillApplication(input({ checkpoints: { load, save: vi.fn() } }), env);
    await vi.advanceTimersByTimeAsync(42000);
    expect(await pending).toMatchObject({ status: 'failed', submitted: false, retryable: true, reason: 'Browser time budget exceeded' });
    expect(remote.launch).not.toHaveBeenCalled();
  });

  it('bounds recovery writes after a browser failure instead of hanging cleanup',async()=>{
    vi.useFakeTimers();remote.launch.mockRejectedValue(new Error('Temporary acquisition failure'));
    const saved:AutomationCheckpoint={binding:input().reviewBinding!,applicationUrl:input().applicationUrl,url:input().applicationUrl,phase:'ready',step:0,signature:'',fields_filled:['email'],mutation_started:false,storage:{cookies:[],origins:[]},session_storage:[]};
    const pending=fillApplication(input({checkpoints:{load:async()=>saved,save:()=>new Promise(()=>{})}}),env);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toMatchObject({status:'needs_action',retryable:false,submitted:false,reason:'Private application recovery could not be saved. Continue manually.'});
  });
});

interface FixtureResponse { status?: number; headers?: Record<string, string>; body?: string; }
interface BrowserProof { submitted?: any; submissionCount?: number; requests: { url: string; method: string }[]; requestBodies?:string[]; close?: ReturnType<typeof vi.fn>; }

async function useLocalBrowser(routes: Record<string, string | FixtureResponse>, proof: BrowserProof, cookies: { name: string; value: string; url: string }[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(options?.redirect).toBe('manual');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const value = routes[new URL(String(url)).pathname] ?? { status: 404, body: 'Not found' };
    const definition = typeof value === 'string' ? { body: value } : value;
    proof.requests.push({ url: String(url), method: options?.method || 'GET' });
    if (options?.body && proof.requestBodies) proof.requestBodies.push(Buffer.from(options.body as ArrayBuffer).toString());
    return new Response(definition.body || '', { status: definition.status || 200, headers: { 'content-type': 'text/html', ...definition.headers } });
  });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined });
  const originalContext = browser.newContext.bind(browser);
  vi.spyOn(browser, 'newContext').mockImplementation(async options => {
    const context = await originalContext(options);
    if (cookies.length) await context.addCookies(cookies);
    const originalRoute = context.route.bind(context);
    vi.spyOn(context, 'route').mockImplementation(async (pattern: any, handler: any) => {
      // Browser routing, cookie handling, DOM, JavaScript and uploads are real;
      // only acquisition and native HTTP response bodies use local fixtures.
      return originalRoute(pattern, handler);
    });
    const originalPage = context.newPage.bind(context);
    vi.spyOn(context, 'newPage').mockImplementation(async () => {
      const page = await originalPage();
      const wait = page.waitForFunction.bind(page);
      vi.spyOn(page, 'waitForFunction').mockImplementation((fn: any, arg: any, options: any) => wait(fn, arg, { ...options, timeout: Math.min(options?.timeout || 300, 300) }));
      return page;
    });
    return context;
  });
  const originalClose = browser.close.bind(browser);
  proof.close = vi.spyOn(browser, 'close').mockImplementation(async () => {
    for (const context of browser.contexts()) for (const page of context.pages()) {
      if (page.isClosed()) continue;
      const state = await page.evaluate(() => ({ submitted: (window as any).submitted, count: (window as any).submissionCount })).catch(() => ({} as any));
      if (state.submitted) proof.submitted = state.submitted;
      if (state.count !== undefined) proof.submissionCount = state.count;
    }
    await originalClose();
  }) as any;
  remote.launch.mockResolvedValue(browser);
}

const executable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath().replace('/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', '/chrome-headless-shell-mac-arm64/headless_shell');
const localBrowserAvailable = existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || chromium.executablePath()) || existsSync(executable);

describe.skipIf(!localBrowserAvailable)('real local HTML form browser behavior', () => {
  it.each(['greenhouse','lever'])('fills an owned %s-shaped public form and sends its PDF once',async portal=>{
    const proof:BrowserProof={requests:[],requestBodies:[]};
    await useLocalBrowser({'/sample':readFileSync(new URL(`./fixtures/public_${portal}_form.html`,import.meta.url),'utf8'),'/submit':'<h1>Application received</h1>'},proof);
    const result=await fillApplication(input(),env);
    expect(result).toMatchObject({status:'applied',submitted:true,retryable:false});
    expect(result.fields_filled).toContain('resume');expect(result.fields_filled).toContain('email');
    expect(result.fields_filled).toContain(portal==='greenhouse'?'first_name':'name');
    expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
    expect(proof.requestBodies![0]).toContain(input().resume.toString());
    expect(proof.requestBodies![0]).toContain('test_resume.pdf');expect(proof.requestBodies![0]).toContain(profile.email);
  });
  it('completes four controlled steps with reviewed facts and exactly one final POST',async () => {
    const proof:BrowserProof={requests:[]},routes={...multiRoutes(),'/multi/sent':'OK'}, checkpoints=memoryCheckpoint();
    await useLocalBrowser(routes,proof);
    const beforeFinalSubmit=vi.fn(async()=>true);
    const result=await fillApplication(input({applicationUrl:`${origin}/multi/contact`,checkpoints:checkpoints.store,beforeFinalSubmit}),env);
    expect(result).toMatchObject({status:'applied',submitted:true,retryable:false});
    expect(proof.requests.filter(item=>item.method==='POST')).toEqual([{url:`${origin}/multi/sent`,method:'POST'}]);
    expect(proof.submitted).toMatchObject({full_name:profile.name,email:profile.email,education:profile.education,experience_years:'0',motivation:input().approvedAnswers!['why do you want to work here'],resume:{name:'test_resume.pdf',size:input().resume.length}});
    expect(checkpoints.saved.filter(item=>item.phase==='ready').map(item=>item.step)).toContain(3);
    expect(checkpoints.value?.phase).toBe('submitted');
    expect(beforeFinalSubmit).toHaveBeenCalledTimes(4);
  });

  it('resumes the last completed step after a transient GET without repeating prior pages or final POST',async () => {
    const proof:BrowserProof={requests:[]},routes=multiRoutes(),checkpoints=memoryCheckpoint();
    routes['/multi/documents']={status:503,body:'Temporary controlled outage'};
    await useLocalBrowser(routes,proof);
    const application=input({applicationUrl:`${origin}/multi/contact`,checkpoints:checkpoints.store});
    expect(await fillApplication(application,env)).toMatchObject({status:'failed',retryable:true,submitted:false});
    expect(checkpoints.value).toMatchObject({phase:'ready',step:1,url:`${origin}/multi/background`});
    routes['/multi/documents']=multiRoutes()['/multi/documents'];routes['/multi/sent']='OK';
    vi.restoreAllMocks();await useLocalBrowser(routes,proof);
    expect(await fillApplication(application,env)).toMatchObject({status:'applied',submitted:true,retryable:false});
    expect(proof.requests.filter(item=>new URL(item.url).pathname==='/multi/contact')).toHaveLength(1);
    expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
    expect(proof.submitted.full_name).toBe(profile.name);
    expect(proof.submitted.session_token).toBe('documents');
  });

  it('requires a fresh final approval and refuses a revoked approval after three completed steps',async () => {
    const proof:BrowserProof={requests:[]},checkpoints=memoryCheckpoint();await useLocalBrowser(multiRoutes(),proof);
    let calls=0;
    expect(await fillApplication(input({applicationUrl:`${origin}/multi/contact`,checkpoints:checkpoints.store,beforeFinalSubmit:async()=>++calls<4}),env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(checkpoints.value?.phase).toBe('ready');
    expect(proof.requests.every(item=>item.method==='GET')).toBe(true);
  });

  it('does not click any final control without an immutable review binding',async()=>{
    const proof:BrowserProof={requests:[]};await useLocalBrowser({'/sample':sample},proof);
    expect(await fillApplication(input({reviewBinding:undefined}),env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(proof.submissionCount).toBe(0);
  });

  it('stops an unknown required question on a later step without submitting',async()=>{
    const proof:BrowserProof={requests:[]},routes=multiRoutes();
    routes['/multi/background']=String(routes['/multi/background']).replace('<button','<label>Do you need visa sponsorship?<select required name="sponsorship"><option value="">Choose</option><option>No</option></select></label><button');
    await useLocalBrowser(routes,proof);
    const result=await fillApplication(input({applicationUrl:`${origin}/multi/contact`}),env);
    expect(result).toMatchObject({status:'needs_action',submitted:false,retryable:false});expect(result.reason).toContain('Required fields need answers');
    expect(proof.requests).toHaveLength(2);
  });

  it('never replays a durable final-submit marker, even under a different review',async()=>{
    const checkpoints=memoryCheckpoint({binding:'old-binding',applicationUrl:`${origin}/sample`,url:`${origin}/sample`,phase:'submitting',step:3,signature:'',fields_filled:[],mutation_started:true,storage:{cookies:[],origins:[]},session_storage:[]});
    expect(await fillApplication(input({checkpoints:checkpoints.store}),env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(remote.launch).not.toHaveBeenCalled();
  });

  it.each([
    ['CAPTCHA','<h1>Verify you are human</h1><div class="h-captcha"></div>','CAPTCHA detected'],
    ['login','<h1>Sign in to continue</h1><input type="password">','account sign-in or registration'],
    ['expired vacancy','<h1>This vacancy has now expired</h1>','expired or closed'],
  ])('hands off a %s introduced on a later step',async(_kind,body,reason)=>{
    const proof:BrowserProof={requests:[]},routes=multiRoutes();routes['/multi/background']=body;await useLocalBrowser(routes,proof);
    const result=await fillApplication(input({applicationUrl:`${origin}/multi/contact`}),env);
    expect(result).toMatchObject({status:'needs_action',submitted:false,retryable:false,manual_action_url:`${origin}/multi/background`});expect(result.reason).toContain(reason);
    expect(proof.requests.every(item=>item.method==='GET')).toBe(true);
  });

  it('never retries an intermediate POST when its response cannot establish the next completed step',async()=>{
    const proof:BrowserProof={requests:[]},checkpoints=memoryCheckpoint();
    await useLocalBrowser({'/sample':nativeForm.replace('action="/submit"','action="/draft"').replace('>Apply<','>Next<'),'/draft':{status:503,body:'Uncertain draft response'}},proof);
    const application=input({checkpoints:checkpoints.store});
    expect(await fillApplication(application,env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(checkpoints.value?.phase).toBe('uncertain');
    expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
    const launches=remote.launch.mock.calls.length;
    expect(await fillApplication(application,env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(remote.launch).toHaveBeenCalledTimes(launches);
  });

  it('retains the specific CAPTCHA reason after an intermediate POST and still prohibits retry',async()=>{
    const proof:BrowserProof={requests:[]};
    await useLocalBrowser({'/sample':nativeForm.replace('>Apply<','>Next<'),'/submit':'<h1>Verify you are human</h1><div class="h-captcha"></div>'},proof);
    expect(await fillApplication(input(),env)).toMatchObject({status:'needs_action',reason:'CAPTCHA detected',submitted:false,retryable:false});
    expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
  });

  it('keeps an uncertain final POST durable and never repeats it on another delivery',async()=>{
    const proof:BrowserProof={requests:[]},checkpoints=memoryCheckpoint();
    await useLocalBrowser({'/sample':nativeForm,'/submit':{status:503,body:'Unknown employer result'}},proof);
    const application=input({checkpoints:checkpoints.store});
    expect(await fillApplication(application,env)).toMatchObject({status:'needs_action',submitted:true,retryable:false});
    expect(checkpoints.value?.phase).toBe('uncertain');const launches=remote.launch.mock.calls.length;
    expect(await fillApplication(application,env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});
    expect(remote.launch).toHaveBeenCalledTimes(launches);expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
  });

  it('blocks a site script that automatically repeats the final POST after an uncertain response',async()=>{
    const proof:BrowserProof={requests:[]};
    const form=nativeForm.replace('</form>',`</form><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();for(let i=0;i<2;i++){try{await fetch('/submit',{method:'POST',body:'same reviewed application'});}catch{}}};</script>`);
    await useLocalBrowser({'/sample':form,'/submit':{status:503,body:'Unknown result'}},proof);
    expect(await fillApplication(input(),env)).toMatchObject({status:'needs_action',submitted:true,retryable:false});
    expect(proof.requests.filter(item=>item.method==='POST')).toHaveLength(1);
  });

  it('refuses unreviewed optional text and profile-default answer guesses',async()=>{
    const proof:BrowserProof={requests:[]};await useLocalBrowser({'/sample':sample.replace('name="motivation" required','name="motivation"')},proof);
    const result=await fillApplication(input({approvedAnswers:{},profile:{...profile,answers:{'why do you want to work here':'Unreviewed profile default'}}}),env);
    expect(result).toMatchObject({status:'needs_action',submitted:false,retryable:false});expect(result.reason).toContain('written answer needs review');
    expect(proof.submissionCount).toBe(0);
  });

  it('never substitutes the candidate identity for a required reference given name',async()=>{
    const proof:BrowserProof={requests:[]};await useLocalBrowser({'/sample':sample.replace('<button','<label>Reference first name<input name="reference_first_name" required></label><button')},proof);
    const result=await fillApplication(input(),env);
    expect(result).toMatchObject({status:'needs_action',submitted:false,retryable:false});expect(result.reason).toContain('reference first name');expect(proof.submissionCount).toBe(0);
  });

  it.each([
    '<label><input type="checkbox" name="consent" checked>I consent to data processing</label>',
    '<label>Visa sponsorship<select name="sponsorship"><option selected>No</option><option>Yes</option></select></label>',
  ])('does not authorize prefilled optional answers or consent: %s',async field=>{
    const proof:BrowserProof={requests:[]};await useLocalBrowser({'/sample':sample.replace('<button',`${field}<button`)},proof);
    expect(await fillApplication(input(),env)).toMatchObject({status:'needs_action',submitted:false,retryable:false});expect(proof.submissionCount).toBe(0);
  });

  it('stops before advancing when a durable checkpoint cannot be written',async()=>{
    const proof:BrowserProof={requests:[]};await useLocalBrowser(multiRoutes(),proof);
    const checkpoints={load:async()=>null,save:async()=>{throw new Error('Private storage outage');}};
    const result=await fillApplication(input({applicationUrl:`${origin}/multi/contact`,checkpoints}),env);
    expect(result).toMatchObject({status:'needs_action',submitted:false,retryable:false});expect(result.reason).toContain('recovery could not be saved');
    expect(proof.requests).toHaveLength(1);
  });

  it('fills all standard fields, uploads PDF bytes and uses only the reviewed written answer', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': sample }, proof);
    const answer = vi.fn(async () => 'UNREVIEWED LLM OUTPUT');
    const result = await fillApplication(input({ answer }), env);
    expect(result).toMatchObject({ status: 'applied', submitted: true, retryable: false, reason: null });
    expect(new Set(result.fields_filled)).toEqual(new Set(['name', 'email', 'phone', 'education', 'experience_years', 'skills', 'free_text', 'resume']));
    expect(proof.submitted).toMatchObject({ full_name: 'Test User', email: profile.email, phone: profile.phone, education: 'BTech', experience_years: '0', skills: 'Python; FastAPI; LangChain', motivation: input().approvedAnswers!['why do you want to work here'] });
    expect(proof.submitted.resume).toEqual({ name: 'test_resume.pdf', size: input().resume.length, type: 'application/pdf' });
    expect(proof.submissionCount).toBe(1);
    expect(answer).not.toHaveBeenCalled();
    expect(proof.close).toHaveBeenCalledOnce();
  });

  it('detects CAPTCHA before filling or clicking and closes the browser', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': captchaForm }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', reason: 'CAPTCHA detected', submitted: false, retryable: false, fields_filled: [] });
    expect(proof.submissionCount).toBe(0);
    expect(proof.close).toHaveBeenCalledOnce();
  });

  it.each(['<div class="h-captcha"></div>', '<img alt="CAPTCHA challenge" src="data:image/png;base64,AA==">'])('recognizes another challenge: %s', async challenge => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': `${flaky}${challenge}` }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', reason: 'CAPTCHA detected', submitted: false });
  });

  it('refuses unknown required defaults and never grants consent implicitly', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': manual.replace('<option>Yes</option>', '<option selected>Yes</option>') }, proof);
    const result = await fillApplication(input(), env);
    expect(result.status).toBe('needs_action');
    expect(result.reason).toContain('Required fields need answers');
    expect(result.submitted).toBe(false);
    expect(proof.submissionCount).toBe(0);
  });

  it('allows explicitly supplied required answers', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': manual }, proof);
    expect(await fillApplication(input({ approvedAnswers: { 'are you authorized to work in this country': 'Yes', 'i consent to data processing': 'true' } }), env)).toMatchObject({ status: 'applied', submitted: true });
    expect(proof.submissionCount).toBe(1);
  });

  it('selects only the explicitly requested radio option', async () => {
    const proof: BrowserProof = { requests: [] };
    const radios = '<label>Work authorization Yes<input type="radio" name="work_authorization" value="yes" required></label><label>Work authorization No<input type="radio" name="work_authorization" value="no" required></label>';
    await useLocalBrowser({ '/sample': sample.replace('<button type="submit">', `${radios}<button type="submit">`) }, proof);
    expect(await fillApplication(input({ approvedAnswers: { ...input().approvedAnswers, 'work authorization yes': 'Yes', 'work authorization no': 'Yes' } }), env)).toMatchObject({ status: 'applied', submitted: true });
    expect(proof.submitted.work_authorization).toBe('yes');
  });

  it('never interprets an explicit false consent answer as permission', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': manual.replace('name="consent" required', 'name="consent" value="false" required') }, proof);
    expect(await fillApplication(input({ approvedAnswers: { 'are you authorized to work in this country': 'Yes', 'i consent to data processing': 'false' } }), env)).toMatchObject({ status: 'needs_action', submitted: false, retryable: false });
    expect(proof.submissionCount).toBe(0);
  });

  it('never uses an LLM callback to invent an unreviewed answer', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': sample }, proof);
    const result = await fillApplication(input({ approvedAnswers: {}, answer: async () => { throw new Error('secret-provider-error'); } }), env);
    expect(result).toMatchObject({ status: 'needs_action', submitted: false, retryable: false });
    expect(result.reason).not.toContain('secret-provider-error');
    expect(proof.submissionCount).toBe(0);
  });

  it('never retries an ambiguous submission', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': flaky }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: true, retryable: false });
    expect(proof.submissionCount).toBe(1);
    expect(remote.launch).toHaveBeenCalledOnce();
  });

  it('does not accept an unchanged preexisting confirmation footer', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': `${flaky}<footer>Thank you for applying</footer>` }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: true, retryable: false });
    expect(proof.submissionCount).toBe(1);
  });

  it('does not accept a URL change alone as submission proof', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': nativeForm, '/submit': { status: 303, headers: { location: '/thanks' } }, '/thanks': '<h1>Career opportunities</h1>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: true, retryable: false });
    expect(proof.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('detects a CAPTCHA introduced after clicking submit', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': nativeForm.replace('method="post"', 'onsubmit="event.preventDefault();document.body.insertAdjacentHTML(\'beforeend\',\'<div class=h-captcha></div>\')"') }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', reason: 'CAPTCHA detected', submitted: true, retryable: false });
  });

  it('follows safe canonical GET redirects and confirms a POST-redirect-GET without replaying the POST', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': { status: 302, headers: { location: '/canonical' } }, '/canonical': nativeForm, '/submit': { status: 303, headers: { location: '/thanks' } }, '/thanks': '<h1>Application received</h1>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'applied', submitted: true, retryable: false });
    expect(proof.requests.map(request => new URL(request.url).pathname)).toEqual(['/sample', '/canonical', '/submit', '/thanks']);
    expect(proof.requests.filter(request => request.method === 'POST')).toHaveLength(1);
  });

  it('preserves browser cookies through actual HTTP canonical and POST-redirect-GET responses exactly once', async () => {
    const requests: { path: string; method: string; cookie: string; body: string }[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const entry = { path: request.url!, method: request.method!, cookie: request.headers.cookie || '', body: Buffer.concat(chunks).toString() };
      requests.push(entry);
      if (!entry.cookie.includes('preexisting=browser-value')) { response.writeHead(403); response.end('Existing browser cookie was lost'); return; }
      if (entry.path === '/sample') {
        response.writeHead(308, { Location: '/canonical', 'Set-Cookie': ['entry_token=ready; Path=/; HttpOnly; Secure; SameSite=Lax', 'second_token=ready; Path=/; Secure'] }); response.end();
      } else if (entry.path === '/canonical' && entry.cookie.includes('entry_token=ready') && entry.cookie.includes('second_token=ready')) {
        response.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'form_token=ready; Path=/; HttpOnly; Secure' }); response.end(nativeForm);
      } else if (entry.path === '/submit' && entry.method === 'POST' && entry.cookie.includes('form_token=ready')) {
        response.writeHead(303, { Location: '/thanks', 'Set-Cookie': 'receipt=ready; Path=/; HttpOnly; Secure' }); response.end();
      } else if (entry.path === '/thanks' && entry.method === 'GET' && entry.cookie.includes('receipt=ready')) {
        response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<h1>Application received</h1>');
      } else { response.writeHead(403); response.end('Redirect cookie was lost'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const proof: BrowserProof = { requests: [] };
      await useLocalBrowser({}, proof, [{ name: 'preexisting', value: 'browser-value', url: origin }]);
      const address = server.address() as { port: number };
      // Only the test transport maps this public fixture hostname to loopback.
      // The application still validates its original public URL before fetch.
      vi.mocked(globalThis.fetch).mockImplementation((url, options) => nativeFetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, options));
      expect(await fillApplication(input(), env)).toMatchObject({ status: 'applied', submitted: true, retryable: false });
      expect(requests.map(request => [request.path, request.method])).toEqual([['/sample', 'GET'], ['/canonical', 'GET'], ['/submit', 'POST'], ['/thanks', 'GET']]);
      const posted = requests.filter(request => request.method === 'POST');
      expect(posted).toHaveLength(1); expect(posted[0].body).toContain('Test User'); expect(posted[0].body).toContain('test_resume.pdf');
    } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });

  it('never follows a private redirect target', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } } }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', reason: 'Unsafe application URL', submitted: false, retryable: false });
    expect(proof.requests).toHaveLength(1);
  });

  it('validates submit button formaction before clicking', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': nativeForm.replace('type="submit"', 'type="submit" formaction="http://127.0.0.1/private"') }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', reason: 'Unsafe application URL', submitted: false, retryable: false });
    expect(proof.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('never replays a POST for a 307 redirect', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': nativeForm, '/submit': { status: 307, headers: { location: '/another-submit' } } }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: true, retryable: false });
    expect(proof.requests.filter(request => request.method === 'POST')).toHaveLength(1);
    expect(proof.requests.some(request => request.url.endsWith('/another-submit'))).toBe(false);
  });

  it.each([404, 503])('handles HTTP %i before submission without unhandled exceptions', async status => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': { status, body: 'Career page unavailable' } }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', submitted: false, retryable: status === 503, reason: `Career page returned HTTP ${status}` });
    expect(proof.close).toHaveBeenCalledOnce();
  });

  it('returns a manual action for a listing page without an application form', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>The application form moved</h1>' }, proof);
    const result = await fillApplication(input(), env);
    expect(result).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, manual_action_url: `${origin}/sample` });
    expect(result.reason).toContain('No supported application form');
    expect(proof.requests).toHaveLength(1);
  });

  it('keeps an actual application form structure failure permanent after one attempt', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': nativeForm.replace('<button type="submit">Apply</button>', '') }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', reason: 'Submit selector not found or unavailable', submitted: false, retryable: false });
    expect(remote.launch).toHaveBeenCalledOnce();
    expect(proof.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('recognizes the exact expired-vacancy message from the real Experian listing without choosing a recommended job', async () => {
    const proof: BrowserProof = { requests: [] };
    const listing = '<h1>AI SWE Summer Intern (Remote & Paid)</h1><h2>This vacancy has now expired. Please see similar roles below...</h2><form><label>Newsletter email<input type="email"></label><button>Subscribe</button></form><a href="/another-job">Apply now</a>';
    await useLocalBrowser({ '/sample': listing, '/another-job': nativeForm }, proof);
    const result = await fillApplication(input(), env);
    expect(result).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, fields_filled: [], manual_action_url: `${origin}/sample` });
    expect(result.reason).toContain('vacancy has expired or closed');
    expect(proof.requests.map(request => new URL(request.url).pathname)).toEqual(['/sample']);
  });

  it('follows duplicate explicit Apply hyperlinks to one public ATS form using GET only before the single submission', async () => {
    const proof: BrowserProof = { requests: [] };
    const listing = '<h1>Python Intern</h1><form><label>Email<input type="email"></label><button>Subscribe to job alerts</button></form><a href="https://ats.example.com/application">Apply now</a><a href="https://ats.example.com/application">Apply</a>';
    await useLocalBrowser({ '/sample': listing, '/application': nativeForm, '/submit': '<h1>Application received</h1>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'applied', submitted: true, retryable: false });
    expect(proof.requests.map(request => ({ path: new URL(request.url).pathname, method: request.method }))).toEqual([
      { path: '/sample', method: 'GET' }, { path: '/application', method: 'GET' }, { path: '/submit', method: 'POST' },
    ]);
  });

  it('does not choose between multiple different Apply destinations', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>Jobs</h1><a href="/one">Apply</a><a href="/two">Apply now</a>' }, proof);
    const result = await fillApplication(input(), env);
    expect(result).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, fields_filled: [] });
    expect(result.reason).toContain('Multiple Apply destinations');
    expect(proof.requests).toHaveLength(1);
  });

  it('returns the actual ATS login URL without filling identity or submitting an account form', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>Python Intern</h1><a href="/account">Start application</a>', '/account': '<h1>Sign in to apply</h1><form><label>Email<input name="email" type="email" required></label><label>Password<input type="password" required></label><button>Sign in</button></form>' }, proof);
    const result = await fillApplication(input(), env);
    expect(result).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, fields_filled: [], manual_action_url: `${origin}/account` });
    expect(result.reason).toContain('account sign-in or registration');
    expect(proof.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('does not mistake an email-only sign-in form for an application', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>Sign in to continue your application</h1><form><label>Email<input type="email" required></label><button>Sign in</button></form>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, fields_filled: [] });
    expect(proof.requests.every(request => request.method === 'GET')).toBe(true);
  });

  it('does not click an interactive Apply button with unknown side effects', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>Python Intern</h1><button onclick="window.submissionCount=1">Apply now</button>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: false, retryable: false });
    expect(proof.submissionCount || 0).toBe(0);
    expect(proof.requests).toHaveLength(1);
  });

  it('rejects an unsafe Apply link before navigating or filling anything', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<h1>Python Intern</h1><a href="http://169.254.169.254/private">Apply now</a>' }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'failed', reason: 'Unsafe application URL', submitted: false, retryable: false, fields_filled: [] });
    expect(proof.requests).toHaveLength(1);
  });

  it('bounds Apply-link chains and returns the last safe page for manual action', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': '<a href="/step1">Apply</a>', '/step1': '<a href="/step2">Apply now</a>', '/step2': '<a href="/step3">Start application</a>', '/step3': nativeForm }, proof);
    expect(await fillApplication(input(), env)).toMatchObject({ status: 'needs_action', submitted: false, retryable: false, manual_action_url: `${origin}/step2` });
    expect(proof.requests.map(request => new URL(request.url).pathname)).toEqual(['/sample', '/step1', '/step2']);
  });
});
