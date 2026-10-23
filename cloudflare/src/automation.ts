import { Buffer } from 'node:buffer';
import { launch } from '@cloudflare/playwright';
import type { Env } from './types';
import { normalizeReviewQuestion } from './review_contract';
import type { AutomationCheckpoint, AutomationCheckpointStore } from './automation_checkpoints';

type Browser = Awaited<ReturnType<typeof launch>>;
type Page = Awaited<ReturnType<Browser['newPage']>>;
type Locator = ReturnType<Page['locator']>;

export interface ApplicationInput {
  applicationUrl: string;
  profile: Record<string, any>;
  resume: Uint8Array;
  resumeName: string;
  jdText: string;
  answer?: (question: string) => Promise<string>;
  approvedAnswers?: Record<string, string>;
  reviewBinding?: string;
  beforeFinalSubmit?: () => Promise<boolean>;
  checkpoints?: AutomationCheckpointStore;
}

export interface ApplicationResult {
  status: 'applied' | 'failed' | 'needs_action';
  reason: string | null;
  fields_filled: string[];
  submitted: boolean;
  retryable: boolean;
  manual_action_url?: string;
}

class AutomationError extends Error {
  constructor(message: string, readonly manual = false, readonly temporary = false) {
    super(message);
  }
}

interface ApplicationRequest {
  url(): string;
  method(): string;
  allHeaders(): Promise<Record<string, string>>;
  postDataBuffer(): Buffer | null;
}

async function boundedResourceBody(stream: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  const reader = stream?.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  if (reader) try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 8 * 1024 * 1024) {
        await reader.cancel();
        throw new AutomationError('Application page resource is too large. Open the employer site manually.', true);
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

/**
 * The Cloudflare Playwright fork's in-process node:http path currently loses
 * raw response headers in workerd. Native fetch preserves Location/Set-Cookie.
 * Chromium still owns cookies; forward its actual request headers and fulfill
 * its intercepted response so cookie scope/expiry rules remain browser-owned.
 */
export async function fetchApplicationResource(request: ApplicationRequest, timeout: number) {
  const url = validatePublicUrl(request.url());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = new Headers(await request.allHeaders());
    for (const name of ['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding']) headers.delete(name);
    // Do not negotiate encodings that a development/runtime bridge might pass
    // through as opaque bytes. Gzip has an unambiguous signature to normalize.
    headers.set('accept-encoding', 'gzip');
    const method = request.method();
    const postData = ['GET', 'HEAD'].includes(method) ? null : request.postDataBuffer();
    const response = await fetch(url, { method, headers, redirect: 'manual', signal: controller.signal,
      body: postData ? new Uint8Array(postData).buffer : undefined });
    const returned: Record<string, string> = {};
    for (const [name, value] of response.headers) {
      // fetch decodes compressed bodies. Do not tell Chromium to decode again
      // or reuse the compressed length/hop-by-hop transport metadata.
      if (!['set-cookie', 'content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) returned[name] = value;
    }
    const cookies = response.headers.getSetCookie();
    if (cookies.length) returned['set-cookie'] = cookies.join('\n');
    let body = await boundedResourceBody(response.body);
    // Production fetch normally exposes decoded content. Some local bridges
    // retain compressed bytes with the same header; never decode plain text a
    // second time, and bound the inflated body as well as the transport body.
    if (response.headers.get('content-encoding')?.toLowerCase() === 'gzip' && body[0] === 0x1f && body[1] === 0x8b) {
      body = await boundedResourceBody(new Blob([new Uint8Array(body).buffer]).stream().pipeThrough(new DecompressionStream('gzip')));
    }
    return { status: response.status, headers: returned, body };
  } finally { clearTimeout(timer); }
}

/** Return a normalized public HTTP(S) URL; never accept local files or credentials. */
export function validatePublicUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AutomationError('Unsafe application URL'); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !host || !host.includes('.') && !host.includes(':') ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal' || host.endsWith('.home.arpa')) {
    throw new AutomationError('Unsafe application URL');
  }
  if (/^[\d.]+$/.test(host)) {
    const octets = host.split('.').map(Number);
    const [a, b, c] = octets;
    if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255) ||
        a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 ||
        a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19) ||
        a === 192 && b === 0 && (c === 0 || c === 2) || a === 192 && b === 88 && c === 99 ||
        a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113) {
      throw new AutomationError('Unsafe application URL');
    }
  } else if (host.includes(':')) {
    const groups = host.replace(/^\[|\]$/g, '').split(':');
    const first = parseInt(groups[0] || '0', 16);
    const second = parseInt(groups[1] || '0', 16);
    // Permit global unicast, excluding documentation and transition networks.
    // This also rejects loopback, mapped IPv4, link-local, ULA and multicast.
    if ((first & 0xe000) !== 0x2000 || first === 0x2002 ||
        first === 0x2001 && (second === 0 || second === 0xdb8)) {
      throw new AutomationError('Unsafe application URL');
    }
  }
  url.hash = '';
  return url.toString();
}

const captchaSelectors = [
  'iframe[src*="recaptcha" i]', '.g-recaptcha', '[data-sitekey]',
  'iframe[src*="hcaptcha" i]', '.h-captcha', '.cf-turnstile',
  'iframe[src*="challenges.cloudflare.com" i]', 'img[src*="captcha" i]',
  'img[alt*="captcha" i]', 'input[name*="captcha" i]:not([type="hidden"])', '#captcha-challenge',
].join(',');
const closedVacancy = /\b(?:this|the)\s+(?:job|vacancy|position|opportunity)\s+(?:(?:has|is)\s+(?:now\s+)?)?(?:expired|closed|been filled)\b|\bno longer accepting applications\b|\b(?:job|vacancy|position) (?:is )?no longer (?:available|open)\b|\bapplications (?:are|have been) closed\b/i;

async function captcha(page: Page): Promise<boolean> {
  if (await page.locator(captchaSelectors).count()) return true;
  const text = (await page.locator('body').innerText()).toLowerCase();
  return ['verify you are human', 'verify that you are human', 'complete the captcha',
    'select all images', 'enter the characters shown', 'i am not a robot'].some(term => text.includes(term));
}

function text(value: any): string {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('; ');
  if (typeof value === 'object') return Object.values(value).map(text).filter(Boolean).join(', ');
  return String(value);
}

async function applicationForm(page: Page, laterStep = false): Promise<Locator | undefined> {
  const forms = await page.locator('form').all();
  let form: Locator | undefined;
  for (const candidate of forms) {
    if (await candidate.isVisible() && await candidate.locator('input[type="file"]').count()) { form = candidate; break; }
  }
  if (!form) for (const candidate of forms) {
    if (await candidate.isVisible() && await candidate.locator('input[type="email"]').count() &&
        !/newsletter|subscribe|job alerts?|sign in|log in|create (?:an? )?account/i.test(await candidate.innerText())) { form = candidate; break; }
  }
  if (!form) for (const candidate of forms) {
    if (!await candidate.isVisible() || /newsletter|subscribe|job alerts?|sign in|log in|create (?:an? )?account/i.test(await candidate.innerText())) continue;
    if (await candidate.evaluate(el => el.matches('#application_form,#application-form,[data-qa="application-form"],[data-application-step],[aria-label*="application" i]')) || laterStep) {
      if (await candidate.locator('button,input[type="submit"]').count()) { form = candidate; break; }
    }
  }
  return form;
}

async function applicationEntry(page: Page): Promise<string | undefined> {
  const targets = new Set<string>();
  const label = /^(?:apply(?:\s+(?:now|online|for (?:this |the )?(?:job|role|position)))?|start (?:your |an? )?application|continue (?:your |the )?application)$/i;
  for (const link of await page.locator('a[href]').all()) {
    if (!await link.isVisible()) continue;
    const title = (await link.innerText() || await link.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!label.test(title)) continue;
    const href = await link.getAttribute('href');
    if (!href || href.trim().startsWith('#')) continue;
    const target = validatePublicUrl(new URL(href, page.url()).toString());
    if (target !== validatePublicUrl(page.url())) targets.add(target);
  }
  if (targets.size > 1) throw new AutomationError('Multiple Apply destinations found. Choose the correct employer application manually.', true);
  return targets.values().next().value;
}

async function formFields(form: Locator, input: ApplicationInput, filled: string[], check: () => void): Promise<Locator> {
  const required: string[] = [];
  // Only the immutable, explicitly reviewed answer snapshot is authoritative.
  // Profile defaults and an LLM callback cannot authorize employer questions.
  const answers = input.approvedAnswers || {};
  const name = text(input.profile.name).trim().split(/\s+/);
  const aliases: [string, RegExp][] = [
    ['email', /\bemail\b|e mail/], ['phone', /\bphone\b|\bmobile\b|\btel\b/],
    ['education', /education|degree|qualification/],
    ['experience_years', /experience.*years|years.*experience|years of exp/],
    ['skills', /\bskills\b|technologies/], ['name', /full name|your name|\bname\b/],
  ];
  for (const field of await form.locator('input, textarea, select').all()) {
    check();
    const kind = (await field.getAttribute('type') || 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(kind) || await field.isDisabled()) continue;
    if (kind !== 'file' && !await field.isVisible()) continue;
    const question = await field.evaluate(el => {
      const input = el as HTMLInputElement;
      const legend = ['radio', 'checkbox'].includes(input.type) ? input.closest('fieldset')?.querySelector('legend')?.innerText : '';
      const labels = Array.from(input.labels || []).map(label => { const copy = label.cloneNode(true) as HTMLElement; copy.querySelectorAll('input,textarea,select,button').forEach(child => child.remove()); return copy.textContent || ''; }).join(' ');
      return legend || labels || input.getAttribute('aria-label') || input.getAttribute('placeholder') || input.name || input.id;
    });
    const descriptor = (await field.evaluate(el => [
      ...Array.from((el as HTMLInputElement).labels || []).map(label => label.innerText),
      ...['name', 'id', 'placeholder', 'aria-label', 'autocomplete'].map(attr => el.getAttribute(attr) || ''),
    ].join(' '))).replace(/[_-]/g, ' ').toLowerCase().trim();
    if (kind === 'file' && /resume|\bcv\b/.test(descriptor)) {
      await field.setInputFiles({ name: input.resumeName.split(/[\\/]/).pop()!, mimeType: 'application/pdf', buffer: Buffer.from(input.resume) });
      filled.push('resume');
      continue;
    }
    let key: string | undefined;
    let value: any;
    if (/first name|given name/.test(descriptor)) { key = 'first_name'; value = name[0]; }
    else if (/last name|family name|surname/.test(descriptor)) { key = 'last_name'; value = name.slice(1).join(' '); }
    else for (const [candidate, pattern] of aliases) {
      if (pattern.test(descriptor) || candidate === 'email' && kind === 'email') {
        key = candidate; value = input.profile[candidate]; break;
      }
    }
    if (['name','first_name','last_name'].includes(key || '') && /company|employer|reference|referee|manager|school|university|college|emergency contact|parent/.test(descriptor)) key = undefined;
    const normalized = normalizeReviewQuestion(question);
    const explicit = Object.hasOwn(answers, normalized) ? [normalized, answers[normalized]] : undefined;
    if (explicit) { key = descriptor; value = explicit[1]; }
    const tag = await field.evaluate(el => el.tagName.toLowerCase());
    if (!explicit && !key && tag === 'textarea') throw new AutomationError('A written answer needs review. Add this exact question to the application review before continuing.', true);
    if (explicit && tag === 'textarea' && !/skills|technologies/.test(descriptor)) key = 'free_text';
    if (kind === 'checkbox' || kind === 'radio') {
      if (explicit) {
        const desired = String(value).toLowerCase();
        const option = (await field.getAttribute('value') || 'on').toLowerCase();
        const positive = ['true', 'yes', '1'];
        const negative = ['false', 'no', '0'];
        const yes = kind === 'radio'
          ? desired === option || positive.includes(desired) && positive.includes(option) || negative.includes(desired) && negative.includes(option)
          : positive.includes(desired) || !negative.includes(desired) && desired !== '' && desired === option;
        if (kind === 'checkbox') await field.setChecked(yes);
        else if (yes) await field.check();
        if (yes || kind === 'checkbox') filled.push(key!);
      } else if (await field.getAttribute('required') !== null || await field.isChecked()) required.push(descriptor || kind);
      continue;
    }
    const rendered = text(value);
    if (key && rendered) {
      if (tag === 'select') {
        const options = await field.evaluate(el => Array.from((el as unknown as HTMLSelectElement).options).map(option => ({ label: option.label.trim(), value: option.value, disabled: option.disabled })));
        const selected = options.find(option => !option.disabled && (option.label.toLowerCase() === rendered.toLowerCase() || option.value.toLowerCase() === rendered.toLowerCase()));
        if (!selected) throw new AutomationError(`Select a value for ${descriptor}`, true);
        await field.selectOption(selected.value);
      } else await field.fill(rendered);
      filled.push(key);
    } else if (await field.getAttribute('required') !== null || (await field.inputValue()).trim()) required.push(descriptor || kind);
  }
  if (required.length) throw new AutomationError(`Required fields need answers: ${required.slice(0, 8).join(', ')}`, true);
  return form;
}

async function formSignature(form: Locator): Promise<string> {
  return form.evaluate(el => JSON.stringify(Array.from(el.querySelectorAll<HTMLInputElement>('input,textarea,select,button')).filter(field => field.checkVisibility()).map(field => [field.tagName,field.getAttribute('type') || '',field.name,field.getAttribute('aria-label') || '',field.tagName === 'BUTTON' ? field.textContent?.trim() : ''])));
}

async function stepButton(form: Locator) {
  const next: Locator[] = [], final: Locator[] = [];
  for (const button of await form.locator('button,input[type="submit"],input[type="button"]').all()) {
    if (!await button.isVisible() || !await button.isEnabled()) continue;
    const label = (await button.innerText() || await button.getAttribute('value') || await button.getAttribute('aria-label') || '').replace(/\s+/g,' ').trim();
    if (/^(?:next(?: step)?|continue(?: to (?:review|application|next step))?|review(?: application)?|save and continue)$/i.test(label)) next.push(button);
    else if (/^(?:submit(?: application)?|send application|apply(?: now)?|finish(?: application)?)$/i.test(label)) final.push(button);
  }
  if (!next.length && !final.length) throw new AutomationError('Submit selector not found or unavailable');
  if (next.length + final.length !== 1) throw new AutomationError('The next application action is ambiguous. Continue manually.', true);
  return { button: (next[0] || final[0])!, final: final.length === 1 };
}

async function confirmationTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const pattern = /application (submitted|received)|thank you for applying|application successful|thanks for applying/i;
    return Array.from(document.body.querySelectorAll<HTMLElement>('*')).filter(el =>
      el.checkVisibility() && pattern.test(el.innerText || '') &&
      !Array.from(el.children).some(child => pattern.test((child as HTMLElement).innerText || '')),
    ).map(el => el.innerText.trim());
  });
}

/** One attempt only. The queue owns retries; a clicked submit is never retryable. */
export async function fillApplication(input: ApplicationInput, env: Env): Promise<ApplicationResult> {
  const result: ApplicationResult = { status: 'failed', reason: null, fields_filled: [], submitted: false, retryable: false };
  let browser: Browser | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + 42000;
  let blocked: AutomationError | undefined;
  let redirect: string | undefined;
  let manualUrl: string | undefined;
  let checkpoint: AutomationCheckpoint | null = null;
  let readyCheckpoint: AutomationCheckpoint | null = null;
  let mutationStarted = false;
  let advancing = false;
  let actionMutations = 0;
  const remaining = () => Math.max(1, deadline - Date.now());
  const check = () => {
    if (finished || Date.now() >= deadline) throw new AutomationError('Browser time budget exceeded', false, true);
    if (blocked) throw blocked;
  };
  const work = async () => {
    const url = validatePublicUrl(input.applicationUrl);
    manualUrl = url;
    if (!/\.pdf$/i.test(input.resumeName) || input.resume.length < 5 ||
        String.fromCharCode(...input.resume.subarray(0, 5)) !== '%PDF-') throw new AutomationError('Resume must be a PDF');
    if (input.checkpoints) {
      try { checkpoint = await input.checkpoints.load(); }
      catch { throw new AutomationError('Private browser checkpoint could not be restored. Continue manually.', true); }
      if (checkpoint && (['submitting','submitted','uncertain'].includes(checkpoint.phase) || checkpoint.phase === 'advancing' && checkpoint.mutation_started)) {
        throw new AutomationError('An earlier step or submission may already have reached the employer. Check its status manually before continuing.', true);
      }
      if (checkpoint && (checkpoint.binding !== input.reviewBinding || checkpoint.applicationUrl !== url)) throw new AutomationError('The application review changed. Review the current resume and answers again.', true);
      if (checkpoint) { readyCheckpoint = checkpoint; result.fields_filled.push(...checkpoint.fields_filled); }
    }
    check();
    browser = await launch(env.BROWSER);
    if (finished) { await browser.close(); throw new AutomationError('Browser time budget exceeded', false, true); }
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false, ...(checkpoint ? { storageState: checkpoint.storage } : {}) });
    if (checkpoint) await context.addInitScript(({entries,marker}: {entries:AutomationCheckpoint['session_storage'];marker:string}) => {
      // Restore once per origin. Reapplying the old snapshot on every Next
      // navigation would overwrite a newly rotated CSRF/application token.
      if (sessionStorage.getItem(marker)) return;
      for (const entry of entries) if (entry.origin === location.origin) for (const [name,value] of Object.entries(entry.values)) sessionStorage.setItem(name,value);
      sessionStorage.setItem(marker,'1');
    }, {entries:checkpoint.session_storage,marker:`__hireflow_restore_${crypto.randomUUID()}`});
    const save = async (value: AutomationCheckpoint) => {
      check();
      if (input.checkpoints) try { await input.checkpoints.save(value); } catch { throw new AutomationError('Private application recovery could not be saved. Continue manually.', true); }
      check(); checkpoint = value;
    };
    let page: Page;
    await context.route('**/*', async route => {
      const request = route.request();
      try {
        check();
        validatePublicUrl(request.url());
        if (page && request.isNavigationRequest() && request.frame().page() !== page) {
          blocked = new AutomationError('A new browser window needs manual action', true);
          await route.abort(); return;
        }
        if (!['GET','HEAD','OPTIONS'].includes(request.method())) {
          if (!advancing && !result.submitted) throw new AutomationError('This application sends data before the reviewed submission step. Continue manually.', true);
          if (actionMutations++ > 0) throw new AutomationError('An additional application request needs manual review. Check whether the previous request was received before continuing.', true);
          mutationStarted = true;
          if (checkpoint && !checkpoint.mutation_started) await save({ ...checkpoint, mutation_started: true });
        }
        // Interception alone does not guard redirected URLs. Fetch exactly one
        // response, inspect Location, and explicitly navigate safe GET hops.
        const response = await fetchApplicationResource(request, Math.min(10000, remaining()));
        if (response.status >= 500 && request.isNavigationRequest()) blocked = new AutomationError(`Career page returned HTTP ${response.status}`, false, true);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.location;
          if (!location) {
            console.warn('application_redirect_missing_location', {
              host: new URL(request.url()).hostname, status: response.status,
              method: request.method(), navigation: request.isNavigationRequest(),
              header_names: Object.keys(response.headers).sort(),
            });
            throw new AutomationError('Redirect needs manual action', true);
          }
          const next = validatePublicUrl(new URL(location, request.url()).toString());
          const main = request.isNavigationRequest() && request.frame() === page?.mainFrame();
          if (main && (request.method() === 'GET' || [301, 302, 303].includes(response.status))) {
            redirect = next;
            // Complete the current document before driving the next GET. An
            // aborted navigation can commit an error page after the next goto.
            await route.fulfill({ status: 200, contentType: 'text/html',
              headers: response.headers['set-cookie'] ? { 'set-cookie': response.headers['set-cookie'] } : {},
              body: '<!doctype html><title>Loading application</title>' });
          } else {
            blocked = new AutomationError('Redirect needs manual action; check whether the application was received', true);
            await route.abort();
          }
          return;
        }
        await route.fulfill(response);
      } catch (error) {
        blocked = error instanceof AutomationError ? error : new AutomationError('Temporary network failure', false, true);
        await route.abort().catch(() => {});
      }
    });
    if (context.routeWebSocket) await context.routeWebSocket('**/*', socket => socket.close());
    page = await context.newPage();
    page.setDefaultTimeout(3000);
    page.setDefaultNavigationTimeout(10000);
    const navigate = async (target: string) => {
      const seen = new Set<string>();
      for (let hop = 0; hop < 5; hop++) {
        check();
        const next = validatePublicUrl(target);
        if (seen.has(next)) throw new AutomationError('Redirect loop needs manual action', true);
        seen.add(next); redirect = undefined;
        let response;
        try { response = await page.goto(next, { waitUntil: 'domcontentloaded', timeout: Math.min(10000, remaining()) }); }
        catch (error) { if (!redirect) { check(); throw error; } }
        check();
        if (redirect) { target = redirect; continue; }
        manualUrl = validatePublicUrl(page.url());
        if (response && response.status() >= 500) throw new AutomationError(`Career page returned HTTP ${response.status()}`, false, true);
        if (response && response.status() >= 400) throw new AutomationError(`Career page returned HTTP ${response.status()}`);
        return;
      }
      throw new AutomationError('Too many redirects; manual action required', true);
    };
    await navigate(checkpoint?.url || url);
    let selected: Locator | undefined;
    const entryPages = new Set([manualUrl]);
    for (let hop = 0; hop <= 2; hop += 1) {
      check();
      if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
      const body = await page.locator('body').innerText();
      if (closedVacancy.test(body)) {
        throw new AutomationError('This vacancy has expired or closed. Check the employer site for a current opening; no application was submitted.', true);
      }
      const passwords = page.locator('input[type="password"]');
      if (await passwords.count()) for (const password of await passwords.all()) {
        if (await password.isVisible()) throw new AutomationError('The employer requires account sign-in or registration. Open the application and continue manually.', true);
      }
      selected = await applicationForm(page, !!checkpoint);
      if (selected) break;
      const next = await applicationEntry(page);
      if (!next) {
        const reason = /\b(?:sign in|log in|create (?:an? )?account)\b[\s\S]{0,100}\b(?:apply|application|continue)\b/i.test(body)
          ? 'The employer requires account sign-in or registration. Open the application and continue manually.'
          : 'No supported application form is available on this page. Use the employer\'s Apply option to continue manually.';
        throw new AutomationError(reason, true);
      }
      if (hop === 2 || entryPages.has(next)) throw new AutomationError('The employer application needs additional navigation. Open it and continue manually.', true);
      entryPages.add(next);
      // Follow only an explicit public Apply hyperlink as a GET. Never click an
      // unknown control, sign in, create an account, or submit a listing page.
      await navigate(next);
    }
    if (!selected) throw new AutomationError('No supported application form is available. Continue manually on the employer site.', true);
    if (checkpoint && await formSignature(selected) !== checkpoint.signature) throw new AutomationError('The saved application step changed or cannot be restored safely. Continue manually.', true);
    const snapshot = async (form: Locator, step: number, phase: AutomationCheckpoint['phase']): Promise<AutomationCheckpoint> => ({
      binding: input.reviewBinding || '', applicationUrl: url, url: validatePublicUrl(page.url()), phase, step,
      signature: await formSignature(form), fields_filled: [...new Set(result.fields_filled)], mutation_started: false,
      storage: await context.storageState(),
      session_storage: await page.evaluate(() => [{ origin: location.origin, values: Object.fromEntries(Array.from({length:sessionStorage.length},(_,i) => sessionStorage.key(i)!).filter(key=>!key.startsWith('__hireflow_restore_')).map(key => [key,sessionStorage.getItem(key)!])) }]),
    });
    let finalButton: Locator | undefined;
    for (let step = checkpoint?.step || 0; step < 8; step++) {
      check();
      if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
      if (await page.locator('input[type="password"]:visible').count()) throw new AutomationError('The employer requires account sign-in or registration. Continue manually.', true);
      const current = selected || await applicationForm(page, true);
      if (!current) throw new AutomationError('Application form selector not found');
      const form = await formFields(current, input, result.fields_filled, check);
      const action = await stepButton(form);
      const target = await action.button.evaluate(el => {
      const button = el as HTMLButtonElement;
      return button.hasAttribute('formaction') ? button.formAction : button.form?.action || location.href;
      });
      validatePublicUrl(target);
      if (!await form.evaluate(el => (el as HTMLFormElement).checkValidity())) throw new AutomationError('Required fields need review', true);
      if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
      if (!result.fields_filled.length) throw new AutomationError('No supported application fields found');
      readyCheckpoint = await snapshot(form, step, 'ready');
      await save(readyCheckpoint);
      if (action.final) { finalButton = action.button; break; }
      if (!input.reviewBinding || !input.beforeFinalSubmit || !await input.beforeFinalSubmit()) throw new AutomationError('The application approval changed. Review again before continuing.', true);
      check();
      await save({ ...readyCheckpoint, phase: 'advancing' });
      advancing = true; mutationStarted = false; actionMutations = 0;
      const previousSignature = readyCheckpoint.signature;
      try { await action.button.click({ timeout: Math.min(5000,remaining()) }); }
      catch (error) { if (!redirect) throw error; }
      check();
      if (redirect) await navigate(redirect);
      manualUrl = validatePublicUrl(page.url());
      if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
      if (await page.locator('input[type="password"]:visible').count()) throw new AutomationError('The employer requires account sign-in or registration. Continue manually.', true);
      if (closedVacancy.test(await page.locator('body').innerText())) throw new AutomationError('This vacancy has expired or closed. Continue manually on the employer site.', true);
      await page.waitForFunction(({ previousSignature }) => {
        const forms = Array.from(document.forms).filter(form => form.checkVisibility());
        return forms.some(form => JSON.stringify(Array.from(form.querySelectorAll<HTMLInputElement>('input,textarea,select,button')).filter(field => field.checkVisibility()).map(field => [field.tagName,field.getAttribute('type') || '',field.name,field.getAttribute('aria-label') || '',field.tagName === 'BUTTON' ? field.textContent?.trim() : ''])) !== previousSignature);
      }, { previousSignature }, { timeout: Math.min(4000,remaining()) });
      check();
      manualUrl = validatePublicUrl(page.url());
      if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
      const body = await page.locator('body').innerText();
      if (closedVacancy.test(body)) throw new AutomationError('This vacancy has expired or closed. Continue manually on the employer site.', true);
      selected = await applicationForm(page,true);
      if (!selected) throw new AutomationError('Application form selector not found');
      await save(await snapshot(selected,step+1,'ready'));
      readyCheckpoint = checkpoint; advancing = false; mutationStarted = false; actionMutations = 0;
    }
    if (!finalButton) throw new AutomationError('This application has too many steps. Continue manually.', true);
    // The durable marker and fresh immutable-review check both precede the
    // irreversible click. No generated or profile-default answer is submitted.
    if (!input.reviewBinding || !input.beforeFinalSubmit || !await input.beforeFinalSubmit()) throw new AutomationError('The reviewed resume or application answers changed or expired. Review again before submitting.', true);
    check();
    if (checkpoint) await save({ ...checkpoint, phase: 'submitting' });
    const before = await confirmationTexts(page);
    check();
    result.submitted = true;
    try { await finalButton.click({ timeout: Math.min(5000, remaining()) }); }
    catch (error) { if (!redirect) throw error; }
    check();
    if (redirect) await navigate(redirect);
    if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
    const evidence = await page.waitForFunction(({ before, captchaSelectors }) => {
      const body = document.body.innerText.toLowerCase();
      if (document.querySelector(captchaSelectors) || ['verify you are human', 'verify that you are human', 'complete the captcha', 'select all images', 'enter the characters shown', 'i am not a robot'].some(phrase => body.includes(phrase))) return 'captcha';
      const pattern = /application (submitted|received)|thank you for applying|application successful|thanks for applying/i;
      return Array.from(document.body.querySelectorAll<HTMLElement>('*')).some(el =>
        el.checkVisibility() && pattern.test(el.innerText || '') && !before.includes(el.innerText.trim()) &&
        !Array.from(el.children).some(child => pattern.test((child as HTMLElement).innerText || '')),
      );
    }, { before, captchaSelectors }, { timeout: Math.min(7000, remaining()) });
    if (await evidence.jsonValue() === 'captcha') throw new AutomationError('CAPTCHA detected', true);
    check();
    if (await captcha(page)) throw new AutomationError('CAPTCHA detected', true);
    result.status = 'applied'; result.reason = null;
    if (checkpoint) await save({ ...checkpoint, phase: 'submitted', mutation_started: true });
  };
  try {
    await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AutomationError('Browser time budget exceeded', false, true)), 42000);
    })]);
  } catch (error) {
    const failure = blocked || (error instanceof AutomationError ? error : undefined);
    result.status = result.submitted || mutationStarted || failure?.manual ? 'needs_action' : 'failed';
    result.reason = failure?.message || (result.submitted
      ? 'Submission could not be confirmed. Check the application before retrying.'
      : 'Temporary browser or network failure');
    result.retryable = !result.submitted && !mutationStarted && result.status === 'failed' && (failure?.temporary ?? true);
    if (mutationStarted && !result.submitted && !failure?.manual) result.reason = 'A previous application step may already have reached the employer. Continue manually to avoid repeating it.';
    if (input.checkpoints && checkpoint) {
      let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const next = result.submitted || mutationStarted
          ? Object.assign({}, checkpoint as AutomationCheckpoint, { phase: 'uncertain' as const, mutation_started: true })
          : result.retryable ? readyCheckpoint : null;
        if (next) await Promise.race([input.checkpoints.save(next), new Promise<never>((_,reject) => {
          recoveryTimer = setTimeout(() => reject(new Error('Recovery timeout')),Math.min(1000,remaining()));
        })]);
      } catch { result.status = 'needs_action'; result.retryable = false; result.reason = 'Private application recovery could not be saved. Continue manually.'; }
      finally { if (recoveryTimer) clearTimeout(recoveryTimer); }
    }
    if (result.status === 'needs_action' && manualUrl) result.manual_action_url = manualUrl;
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    if (browser) {
      let cleanup: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([browser.close().catch(() => {}), new Promise<void>(resolve => { cleanup = setTimeout(resolve, 2000); })]);
      if (cleanup) clearTimeout(cleanup);
    }
  }
  return result;
}
