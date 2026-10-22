import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverJobs } from '../src/intelligence';
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
      if (url.includes('tavily')) return response({ results: [result('https://example.com/jobs/open'), result('https://example.com/jobs/closed'), result('https://example.com/jobs/blocked')] });
      if (url.endsWith('/blocked')) return response({}, 403);
      return html(url.endsWith('/closed') ? { validThrough: '2000-01-01' } : {});
    });
    const jobs = await discoverJobs(env, { name: 'Private Candidate', email: 'private@example.com', mode: 'internship', skills: ['Python'], target_roles: ['AI Engineer'] }, { warn() {}, trace: value => traces.push(value) });
    expect(jobs).toHaveLength(1);
    expect(traces).toContainEqual({ stage: 'fetch', host: 'example.com', status: 403 });
    expect(traces).toContainEqual({ stage: 'rejected', host: 'example.com', reason: 'expired_date' });
    expect(traces).toContainEqual({ stage: 'summary', search_results: 6, unique_candidates: 3, verified: 1, skipped: 5, requests: 5 });
    const serialized = JSON.stringify(traces);
    for (const secret of ['Private Candidate', 'private@example.com', 'mock-search-key', '/jobs/open', 'AI Engineer']) expect(serialized).not.toContain(secret);
  });

  it('searches fresh employer/job-board details without inventing geography or requiring every profile skill', async () => {
    const fetch = mock((url, init) => {
      expect(url).toBe('https://api.tavily.com/search'); expect(init.redirect).toBe('manual');
      const query = JSON.parse(String(init.body));
      expect(query).toMatchObject({ time_range: 'month', include_raw_content: 'text', include_published_date: true, max_results: 8 });
      expect(query.include_domains.length).toBeGreaterThan(1); expect(query.query).toContain('AI Engineer internship Python'); expect(query.query).not.toContain('India'); expect(query.query).not.toContain('React');
      return response({ results: [] });
    });
    const warnings: string[] = [];
    expect(await discoverJobs(env, { mode: 'internship', target_roles: ['AI Engineer'], preferred_locations: [], skills: ['Python', 'React', 'LangGraph'] }, { warn: value => warnings.push(value) })).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2); expect(warnings[0]).toContain('broader target role');
  });

  it('recognizes Internshala, Indeed and Naukri detail URLs and obtains actual structured job fields', async () => {
    const links = ['https://internshala.com/internship/detail/ai-engineering-internship-at-acme123', 'https://in.indeed.com/viewjob?jk=abc123&utm_source=test', 'https://www.naukri.com/job-listings-ai-engineer-intern-acme-123'];
    const fetch = mock(url => url.includes('api.tavily.com') ? response({ results: links.map(url => result(url)) }) : html());
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(3);
    expect(jobs.every(job => job.company === 'Actual Employer' && job.title === 'AI Engineer Intern' && job.location === 'Remote' && job.description === description && job.posted_date === now)).toBe(true);
    expect(jobs[1].url).toBe('https://in.indeed.com/viewjob?jk=abc123'); expect(fetch.mock.calls.filter(([url]) => !String(url).includes('tavily')).every(([, init]) => !init?.method)).toBe(true);
  });

  it('rejects the exact expired-vacancy banner even when stale JobPosting metadata still looks valid', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://experian.example/job/software-engineer-intern-jid-123')] }) : html({}, '<p>This vacancy has now expired. Please see similar roles below...</p>'));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
  });
  it('does not import a generic career department page as an individual job', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://example.com/careers/engineering')] }) : new Response(`<h1>Engineering careers</h1><p>${description}</p><p>Browse our department and join our talent network.</p>`));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
  });
  it('keeps a job valid through today when the source supplies a date without a time', async () => {
    mock(url => url.includes('tavily') ? response({ results: [result('https://example.com/jobs/123')] }) : html({ validThrough: new Date().toISOString().slice(0, 10) }));
    expect(await discoverJobs(env, { mode: 'internship' })).toHaveLength(1);
  });

  it('omits expired validThrough, old posting dates, and search-directory pages', async () => {
    const urls = ['https://example.com/jobs/expired', 'https://example.com/jobs/old', 'https://www.linkedin.com/jobs/search/?keywords=AI', 'https://www.indeed.com/q-ai-intern-jobs.html', 'https://www.naukri.com/ai-internship-jobs', 'https://internshala.com/internships/'];
    const fetch = mock(url => url.includes('tavily') ? response({ results: urls.map(url => result(url)) }) : html(url.endsWith('expired') ? { validThrough: '2000-01-01' } : { datePosted: '2000-01-01' }));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
    expect(fetch.mock.calls.filter(([url]) => /linkedin|indeed|naukri|internshala/.test(String(url)))).toHaveLength(0);
  });

  it('does not classify a senior job as an internship because its description excludes internship experience', async () => {
    const source = result('https://example.com/jobs/senior-python', 'Senior Software Engineer at Acme');
    const fetch = mock(url => url.includes('tavily') ? response({ results: [source] }) : html({ title: 'Senior Software Engineer', employmentType: 'FULL_TIME', description: `${description} Four years required. Internship experience does not apply.` }));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]); expect(fetch).toHaveBeenCalledTimes(2);
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
      if (url.includes('tavily')) return response({ results: Array.from({ length: 8 }, (_, index) => result(`https://example.com/jobs/${index}`, 'AI Engineer Intern at Acme')) });
      if (url.endsWith('/0')) return new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/metadata' } });
      return new Response(null, { status: 302, headers: { Location: '/jobs/loop' } });
    });
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]); expect(fetch.mock.calls.length).toBeLessThanOrEqual(24);
    expect(fetch.mock.calls.every(([url]) => !String(url).includes('169.254'))).toBe(true);
  });
});
