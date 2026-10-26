import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverJobs, type DiscoverySourceSummary } from '../src/intelligence';
import type { Env } from '../src/types';

const env = { TAVILY_API_KEY: 'mock-search-key' } as Env;
const now = new Date(Date.now() - 86400000).toISOString();
const description = 'Build Python and React applications with an engineering team. Implement API endpoints, write tests, review code, and document your decisions. This paid internship includes mentoring and a scoped delivery project.';
const result = (url: string, title = 'AI Engineer Intern at Acme') => ({ url, title, content: description, published_date: now });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const html = (patch: Record<string, unknown> = {}, banner = '') => new Response(`<html><head><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'AI Engineer Intern', hiringOrganization: { name: 'Actual Employer' }, description: `<p>${description}</p>`, datePosted: now, employmentType: 'INTERN', jobLocation: { address: { addressLocality: 'Remote' } }, ...patch })}</script></head><body><h1>AI Engineer Intern</h1>${banner}<article>${description}</article></body></html>`, { headers: { 'Content-Type': 'text/html' } });
function mock(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetch = vi.fn((url: RequestInfo | URL, init: RequestInit = {}) => handler(String(url), init)); vi.stubGlobal('fetch', fetch); return fetch;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('active individual job discovery', () => {
  it('reports safe provider, network and rejection counts without profile facts or credentials', async () => {
    const traces: Record<string, string | number | boolean>[] = [];
    mock(url => {
      if (url.includes('tavily')) return response({ results: [result('https://wellfound.com/jobs/open'), result('https://wellfound.com/jobs/closed'), result('https://wellfound.com/jobs/blocked')] });
      if (url.endsWith('/blocked')) return response({}, 403);
      return html(url.endsWith('/closed') ? { validThrough: '2000-01-01' } : {});
    });
    const jobs = await discoverJobs(env, { name: 'Private Candidate', email: 'private@example.com', mode: 'internship', skills: ['Python'], target_roles: ['AI Engineer'] }, { warn() {}, trace: value => traces.push(value) });
    expect(jobs).toHaveLength(1);
    expect(traces).toContainEqual({ stage: 'fetch', host: 'wellfound.com', status: 403, cache:'none' });
    expect(traces).toContainEqual({ stage: 'rejected', host: 'wellfound.com', reason: 'expired_date' });
    expect(traces).toContainEqual({ stage: 'summary', search_results: 3, unique_candidates: 3, verified: 1, skipped: 2, requests: 8 });
    const serialized = JSON.stringify(traces);
    for (const secret of ['Private Candidate', 'private@example.com', 'mock-search-key', '/jobs/open', 'AI Engineer']) expect(serialized).not.toContain(secret);
  });

  it('searches fresh employer/job-board details without inventing geography or requiring every profile skill', async () => {
    const fetch = mock((url, init) => {
      expect(url).toBe('https://api.tavily.com/search'); expect(init.redirect).toBe('manual');
      const query = JSON.parse(String(init.body));
      expect(query).toMatchObject({ time_range: 'month', include_raw_content: false, include_published_date: true, max_results: 4 });
      expect(query.include_domains.length).toBeGreaterThan(0); expect(query.query).toContain('AI Engineer internship Python'); expect(query.query).not.toContain('India'); expect(query.query).not.toContain('React');
      return response({ results: [] });
    });
    const warnings: string[] = [];
    expect(await discoverJobs(env, { mode: 'internship', target_roles: ['AI Engineer'], preferred_locations: [], skills: ['Python', 'React', 'LangGraph'] }, { warn: value => warnings.push(value) })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(5); expect(warnings[0]).toContain('broader target role');
  });

  it('recognizes Internshala and LinkedIn internship details and obtains actual structured job fields', async () => {
    const links = ['https://internshala.com/internship/detail/ai-engineering-internship-at-acme123', 'https://in.linkedin.com/jobs/view/ai-engineering-intern-123?utm_source=test'];
    const fetch = mock(url => url.includes('api.tavily.com') ? response({ results: links.map(url => result(url)) }) : html());
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(2);
    expect(jobs.every(job => job.company === 'Actual Employer' && job.title === 'AI Engineer Intern' && job.location === 'Remote' && job.description === description && job.posted_date === now)).toBe(true);
    expect(jobs[1].url).toBe('https://in.linkedin.com/jobs/view/ai-engineering-intern-123'); expect(fetch.mock.calls.filter(([url]) => !String(url).includes('tavily')).every(([, init]) => !init?.method)).toBe(true);
  });

  it('rejects the exact expired-vacancy banner even when stale JobPosting metadata still looks valid', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://wellfound.com/jobs/software-engineer-intern-jid-123')] }) : html({}, '<p>This vacancy has now expired. Please see similar roles below...</p>'));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
  });
  it('does not import a generic career department page as an individual job', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://wellfound.com/careers/engineering')] }) : new Response(`<h1>Engineering careers</h1><p>${description}</p><p>Browse our department and join our talent network.</p>`));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
  });
  it('keeps a job valid through today when the source supplies a date without a time', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://wellfound.com/jobs/123')] }) : html({ validThrough: new Date().toISOString().slice(0, 10) }));
    expect(await discoverJobs(env, { mode: 'internship' })).toHaveLength(1);
  });

  it('omits expired validThrough, old posting dates, and search-directory pages', async () => {
    const urls = ['https://wellfound.com/jobs/expired', 'https://wellfound.com/jobs/old', 'https://www.linkedin.com/jobs/search/?keywords=AI', 'https://www.indeed.com/q-ai-intern-jobs.html', 'https://www.naukri.com/ai-internship-jobs', 'https://internshala.com/internships/'];
    const fetch = mock(url => url.includes('tavily') ? response({ results: urls.map(url => result(url)) }) : html(url.endsWith('expired') ? { validThrough: '2000-01-01' } : { datePosted: '2000-01-01' }));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
    expect(fetch.mock.calls.filter(([url]) => /linkedin|indeed|naukri|internshala/.test(String(url)))).toHaveLength(0);
  });

  it('does not classify a senior job as an internship because its description excludes internship experience', async () => {
    const source = result('https://www.linkedin.com/jobs/view/senior-python', 'Senior Software Engineer at Acme');
    const fetch = mock(url => url.includes('tavily') ? response({ results: [source] }) : html({ title: 'Senior Software Engineer', employmentType: 'FULL_TIME', description: `${description} Four years required. Internship experience does not apply.` }));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]); expect(fetch).toHaveBeenCalledTimes(5);
    const jobs = await discoverJobs(env, { mode: 'job' }); expect(jobs).toHaveLength(1); expect(jobs[0].listing_type).toBe('job');
  });

  it('gets a complete Lever JD and company title instead of importing a short search snippet', async () => {
    mock(url => {
      if (url.includes('tavily')) return response({ results: [result('https://jobs.lever.co/realco/abc-123/apply?ref=search', 'Real Company - AI Engineering Intern')] });
      expect(url).toBe('https://api.lever.co/v0/postings/realco/abc-123?mode=json');
      return response({ text: 'AI Engineering Intern', descriptionPlain: description, lists: [{ text: 'Requirements', content: '<li>Python API development and careful testing.</li>' }], additionalPlain: 'Applications are open.', createdAt: Date.parse(now), categories: { location: 'Remote', commitment: 'Internship' } });
    });
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(1); expect(jobs[0].company).toBe('Real Company'); expect(jobs[0].description).toContain('Python API development'); expect(jobs[0].description).toContain('Applications are open'); expect(jobs[0].url).not.toContain('ref=');
  });

  it.each([['AI Engineering Intern', 'euroco'], ['Euro Company - AI Engineering Intern', 'Euro Company']])('supports EU Lever details and company extraction for %s', async (title, company) => {
    mock((url, init) => {
      if (url.includes('tavily')) {
        const domains = JSON.parse(String(init.body)).include_domains;
        return response({ results: domains.includes('jobs.eu.lever.co') ? [result('http://jobs.eu.lever.co/euroco/abc-123?ref=search', title)] : [] });
      }
      expect(url).toBe('https://api.eu.lever.co/v0/postings/euroco/abc-123?mode=json');
      return response({ text: 'AI Engineering Intern', descriptionPlain: description, createdAt: Date.parse(now), categories: { location: 'Paris', commitment: 'Internship' } });
    });
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({source:'Lever',required_skills:['Python','React'],compensation:{disclosed:false},provenance:{kind:'ats_api'}});
    expect(jobs).toMatchObject([{ title: 'AI Engineering Intern', company, description, url: 'https://jobs.eu.lever.co/euroco/abc-123', listing_type: 'internship', location: 'Paris', posted_date: now }]);
  });

  it('verifies Greenhouse public job JSON and omits unpublished jobs rather than falling back to a cached search result', async () => {
    mock(url => {
      if (url.includes('tavily')) return response({ results: [result('http://job-boards.greenhouse.io/acme/jobs/123'), result('https://job-boards.greenhouse.io/closed/jobs/456')] });
      if (url.includes('/closed/')) return response({}, 404);
      expect(url).toBe('https://boards-api.greenhouse.io/v1/boards/acme/jobs/123');
      return response({ title: 'Backend Intern', content: `&lt;p&gt;${description}&lt;/p&gt;`, location: { name: 'Bengaluru' } });
    });
    const jobs = await discoverJobs(env, { mode: 'internship' }); expect(jobs).toHaveLength(1); expect(jobs[0]).toMatchObject({ title: 'Backend Intern', url: 'https://job-boards.greenhouse.io/acme/jobs/123', description, location: 'Bengaluru' });
  });

  it('blocks internal redirects and caps redirects/subrequests when sites misbehave', async () => {
    const fetch = mock(url => {
      if (url.includes('tavily')) return response({ results: Array.from({ length: 8 }, (_, index) => result(`https://wellfound.com/jobs/${index}`, 'AI Engineer Intern at Acme')) });
      if (url.endsWith('/0')) return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/metadata' } });
      return new Response(null, { status: 302, headers: { Location: '/jobs/loop' } });
    });
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]); expect(fetch.mock.calls.length).toBeLessThanOrEqual(24);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('169.254'))).toBe(true);
  });
});

function sourceUrl(domain: string, index = 0): string {
  if (domain === 'internshala.com') return `https://internshala.com/internship/detail/ai-intern-${index}`;
  if (domain === 'linkedin.com') return `https://www.linkedin.com/jobs/view/ai-engineer-${index}`;
  if (domain === 'naukri.com') return `https://www.naukri.com/job-listings-ai-engineer-${index}`;
  if (domain.includes('greenhouse')) return `https://job-boards.greenhouse.io/acme/jobs/${100 + index}`;
  if (domain.includes('lever')) return `https://jobs.lever.co/acme/id-${index}`;
  return `https://wellfound.com/jobs/ai-intern-${index}`;
}
function detail(url: string, internship = true): Response {
  const title = internship ? 'AI Engineer Intern' : 'AI Engineer';
  if (url.includes('boards-api.greenhouse.io')) return response({ title, content: description });
  if (url.includes('api.lever.co')) return response({ text: title, descriptionPlain: description, createdAt: Date.parse(now), categories: { commitment: internship ? 'Internship' : 'Full-time' } });
  return html({ title, employmentType: internship ? 'INTERN' : 'FULL_TIME' });
}

describe('parallel source-aware discovery', () => {
  it('starts five independent internship searches before verification and balances the first eight verified slots', async () => {
    const domains: string[] = [], details: string[] = []; let release!: () => void;
    const allStarted = new Promise<void>(resolve => { release = resolve; });
    let sources: DiscoverySourceSummary[] = [];
    const fetch = mock(async (url, init) => {
      if (url.includes('tavily')) {
        const body = JSON.parse(String(init.body)); domains.push(body.include_domains[0]);
        expect(body.max_results).toBe(4);
        if (domains.length === 5) release();
        await allStarted;
        return response({ results: Array.from({ length: 4 }, (_, index) => result(sourceUrl(body.include_domains[0], index))) });
      }
      expect(domains).toHaveLength(5); details.push(url); return detail(url);
    });
    const jobs = await discoverJobs(env, { mode: 'internship', target_roles: ['AI Engineer'], skills: ['Python'] }, { warn() {}, report: rows => { sources = rows; } });
    expect(domains).toEqual(['internshala.com', 'wellfound.com', 'job-boards.greenhouse.io', 'jobs.lever.co', 'linkedin.com']);
    expect(jobs.map(job => new URL(job.url).hostname)).toEqual(['internshala.com', 'wellfound.com', 'job-boards.greenhouse.io', 'jobs.lever.co', 'www.linkedin.com', 'internshala.com', 'wellfound.com', 'job-boards.greenhouse.io']);
    expect(details).toHaveLength(8); expect(fetch).toHaveBeenCalledTimes(13);
    expect(sources.map(source => [source.id, source.search_calls, source.searched, source.verified, source.status])).toEqual([
      ['internshala', 1, 4, 2, 'ok'], ['wellfound', 1, 4, 2, 'ok'], ['greenhouse', 1, 4, 2, 'ok'], ['lever', 1, 4, 1, 'ok'], ['linkedin', 1, 4, 1, 'ok'],
    ]);
  });

  it('searches Naukri, LinkedIn, Greenhouse and Lever separately for job mode', async () => {
    const domains: string[] = [];
    mock((url, init) => {
      if (url.includes('tavily')) { const body = JSON.parse(String(init.body)); domains.push(body.include_domains[0]); expect(body.query).toContain(' job '); return response({ results: [result(sourceUrl(body.include_domains[0]), 'AI Engineer at Acme')] }); }
      return detail(url, false);
    });
    const jobs = await discoverJobs(env, { mode: 'job', target_roles: ['AI Engineer'], skills: ['Python'] });
    expect(domains).toEqual(['naukri.com', 'linkedin.com', 'job-boards.greenhouse.io', 'jobs.lever.co']);
    expect(jobs).toHaveLength(4); expect(jobs.every(job => job.listing_type === 'job')).toBe(true);
  });

  it('keeps other source results when a search fails and reports blocked and empty sources truthfully', async () => {
    let sources: DiscoverySourceSummary[] = []; const warnings: string[] = [];
    mock((url, init) => {
      if (url.includes('tavily')) {
        const domain = JSON.parse(String(init.body)).include_domains[0];
        if (domain === 'internshala.com') return response({ error: 'private provider text mock-search-key' }, 503);
        return response({ results: domain.includes('greenhouse') || domain === 'linkedin.com' ? [result(sourceUrl(domain))] : [] });
      }
      return url.includes('linkedin') ? response({}, 999) : detail(url);
    });
    const jobs = await discoverJobs(env, { mode: 'internship' }, { warn: message => warnings.push(message), report: rows => { sources = rows; } });
    expect(jobs).toHaveLength(1);
    expect(sources.find(source => source.id === 'internshala')).toMatchObject({ search_calls: 1, searched: 0, verified: 0, status: 'unavailable' });
    expect(sources.find(source => source.id === 'linkedin')).toMatchObject({ search_calls: 1, searched: 1, verified: 0, restricted: 1, status: 'restricted' });
    expect(sources.find(source => source.id === 'wellfound')).toMatchObject({ searched: 0, verified: 0, status: 'empty' });
    expect(sources.find(source => source.id === 'greenhouse')).toMatchObject({ verified: 1, status: 'ok' });
    expect(warnings.join(' ')).toContain('Internshala'); expect(JSON.stringify({ sources, warnings })).not.toContain('mock-search-key');
  });

  it('enforces the requested source hosts instead of trusting provider filtering or attributing cross-source links', async () => {
    let sources: DiscoverySourceSummary[] = [];
    const fetch = mock((url, init) => {
      expect(url).toContain('api.tavily.com');
      const domain = JSON.parse(String(init.body)).include_domains[0];
      return response({ results: domain === 'jobs.lever.co' ? [result('https://internshala.com/internship/detail/wrong-source'), result('https://jobs.lever.co.attacker.example/jobs/fake')] : [] });
    });
    expect(await discoverJobs(env, { mode: 'internship' }, { warn() {}, report: rows => { sources = rows; } })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(5); expect(sources.every(source => source.searched === 0 && source.verified === 0)).toBe(true);
  });

  it('never exceeds 24 requests when every source returns redirecting details', async () => {
    let sources: DiscoverySourceSummary[] = [];
    const fetch = mock((url, init) => {
      if (url.includes('tavily')) { const domain = JSON.parse(String(init.body)).include_domains[0]; return response({ results: Array.from({ length: 4 }, (_, index) => result(sourceUrl(domain, index))) }); }
      return new Response(null, { status: 302, headers: { Location: url } });
    });
    expect(await discoverJobs(env, { mode: 'internship' }, { warn() {}, report: rows => { sources = rows; } })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(24); expect(sources.some(source => source.status === 'budget_limited')).toBe(true);
    expect(sources.every(source => source.search_calls === 1)).toBe(true);
  });

  it('finishes within the shared 35-second deadline when detail requests time out', async () => {
    vi.useFakeTimers(); const start = Date.now(); let sources: DiscoverySourceSummary[] = [];
    mock((url, init) => {
      if (url.includes('tavily')) { const domain = JSON.parse(String(init.body)).include_domains[0]; return response({ results: [result(sourceUrl(domain))] }); }
      return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('Timeout', 'AbortError')), { once: true }));
    });
    const pending = discoverJobs(env, { mode: 'internship' }, { warn() {}, report: rows => { sources = rows; } });
    await vi.advanceTimersByTimeAsync(35000);
    expect(await pending).toEqual([]); expect(Date.now() - start).toBe(35000); expect(sources.some(source => source.restricted > 0)).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
});
