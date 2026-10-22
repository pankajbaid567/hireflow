import { readFileSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chromium } from 'playwright-core';
import type { Env } from '../src/types';

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
  answer: async () => 'I want to build reliable Python agents with FastAPI and LangChain.', ...overrides,
});
const sample = readFileSync(new URL('../../tests/fixtures/sample_form.html', import.meta.url), 'utf8');
const flaky = readFileSync(new URL('../../tests/fixtures/flaky_form.html', import.meta.url), 'utf8');
const captchaForm = readFileSync(new URL('../../tests/fixtures/captcha_form.html', import.meta.url), 'utf8');
const manual = readFileSync(new URL('../../tests/fixtures/manual_action_form.html', import.meta.url), 'utf8');
const nativeForm = `<form method="post" action="/submit" enctype="multipart/form-data">
  <label>Name<input name="name" required></label><label>Email<input name="email" type="email" required></label>
  <label>Resume<input name="resume" type="file" required></label><button type="submit">Apply</button></form>`;

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

  it('includes the entire asynchronous LLM answer in the browser time budget', async () => {
    vi.useFakeTimers();
    const question = { getAttribute: vi.fn(async (name: string) => name === 'required' ? '' : null), isDisabled: vi.fn(async () => false), isVisible: vi.fn(async () => true), evaluate: vi.fn().mockResolvedValueOnce('why do you want to work here').mockResolvedValueOnce('textarea') };
    const form = { isVisible: vi.fn(async () => true), locator: vi.fn((selector: string) => selector === 'input[type="file"]' ? { count: async () => 1 } : { all: async () => [question] }) };
    const page = { setDefaultTimeout: vi.fn(), setDefaultNavigationTimeout: vi.fn(), goto: vi.fn(async () => ({ status: () => 200 })), url: () => `${origin}/sample`, mainFrame: vi.fn(), locator: vi.fn((selector: string) => selector === 'form' ? { all: async () => [form] } : selector === 'body' ? { innerText: async () => 'Apply for an internship' } : { count: async () => 0 }) };
    const context = { route: vi.fn(), newPage: vi.fn(async () => page) };
    const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
    remote.launch.mockResolvedValue(browser);
    const answer = vi.fn(() => new Promise<string>(() => {}));
    const pending = fillApplication(input({ answer }), env);
    await vi.advanceTimersByTimeAsync(42000);
    expect(answer).toHaveBeenCalledOnce();
    expect(await pending).toMatchObject({ status: 'failed', submitted: false, retryable: true, reason: 'Browser time budget exceeded' });
    expect(browser.close).toHaveBeenCalledOnce();
  });
});

interface FixtureResponse { status?: number; headers?: Record<string, string>; body?: string; }
interface BrowserProof { submitted?: any; submissionCount?: number; requests: { url: string; method: string }[]; close?: ReturnType<typeof vi.fn>; }

async function useLocalBrowser(routes: Record<string, string | FixtureResponse>, proof: BrowserProof, cookies: { name: string; value: string; url: string }[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    expect(options?.redirect).toBe('manual');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const value = routes[new URL(String(url)).pathname] ?? { status: 404, body: 'Not found' };
    const definition = typeof value === 'string' ? { body: value } : value;
    proof.requests.push({ url: String(url), method: options?.method || 'GET' });
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
  it('fills all standard fields, uploads PDF bytes and uses the JD-context LLM answer', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': sample }, proof);
    const answer = vi.fn(async (_question: string) => 'I want to build Python agents with FastAPI and LangChain.');
    const result = await fillApplication(input({ answer }), env);
    expect(result).toMatchObject({ status: 'applied', submitted: true, retryable: false, reason: null });
    expect(new Set(result.fields_filled)).toEqual(new Set(['name', 'email', 'phone', 'education', 'experience_years', 'skills', 'free_text', 'resume']));
    expect(proof.submitted).toMatchObject({ full_name: 'Test User', email: profile.email, phone: profile.phone, education: 'BTech', experience_years: '0', skills: 'Python; FastAPI; LangChain', motivation: await answer.mock.results[0].value });
    expect(proof.submitted.resume).toEqual({ name: 'test_resume.pdf', size: input().resume.length, type: 'application/pdf' });
    expect(proof.submissionCount).toBe(1);
    expect(answer.mock.calls[0][0]).toContain(input().jdText);
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
    expect(await fillApplication(input({ profile: { ...profile, answers: { 'work authorization': 'Yes', consent: true } } }), env)).toMatchObject({ status: 'applied', submitted: true });
    expect(proof.submissionCount).toBe(1);
  });

  it('selects only the explicitly requested radio option', async () => {
    const proof: BrowserProof = { requests: [] };
    const radios = '<label>Work authorization Yes<input type="radio" name="work_authorization" value="yes" required></label><label>Work authorization No<input type="radio" name="work_authorization" value="no" required></label>';
    await useLocalBrowser({ '/sample': sample.replace('<button type="submit">', `${radios}<button type="submit">`) }, proof);
    expect(await fillApplication(input({ profile: { ...profile, answers: { 'work authorization': 'Yes' } } }), env)).toMatchObject({ status: 'applied', submitted: true });
    expect(proof.submitted.work_authorization).toBe('yes');
  });

  it('never interprets an explicit false consent answer as permission', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': manual.replace('name="consent" required', 'name="consent" value="false" required') }, proof);
    expect(await fillApplication(input({ profile: { ...profile, answers: { 'work authorization': 'Yes', consent: false } } }), env)).toMatchObject({ status: 'needs_action', submitted: false, retryable: false });
    expect(proof.submissionCount).toBe(0);
  });

  it('requires manual review when the answer callback fails without leaking the error', async () => {
    const proof: BrowserProof = { requests: [] };
    await useLocalBrowser({ '/sample': sample }, proof);
    const result = await fillApplication(input({ answer: async () => { throw new Error('secret-provider-error'); } }), env);
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
