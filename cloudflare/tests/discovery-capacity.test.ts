import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverJobs, type DiscoverySourceSummary } from '../src/intelligence';
import type { Env } from '../src/types';

const env = { TAVILY_API_KEY: 'synthetic-search-test' } as Env;
const description = 'Implement Python and SQL APIs with a supervised engineering team. Write tests and documentation, review changes, and deliver a paid internship project with clear milestones.';
const urlFor = (domain: string, index: number) => domain === 'internshala.com' ? `https://${domain}/internship/detail/python-intern-${index}`
  : domain.includes('greenhouse') ? `https://${domain}/example/jobs/${100 + index}`
    : domain.includes('lever') ? `https://${domain}/example/id-${index}`
      : domain === 'linkedin.com' ? `https://www.${domain}/jobs/view/python-intern-${index}` : `https://${domain}/jobs/python-intern-${index}`;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('bounded discovery evidence and payloads', () => {
  it('keeps five searches and eight full source JDs without requesting duplicate raw pages', async () => {
    const domains: string[] = []; let details = 0; let sources: DiscoverySourceSummary[] = [];
    vi.stubGlobal('fetch', vi.fn((raw: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(raw));
      if (url.hostname === 'api.tavily.com') {
        const query = JSON.parse(String(init.body));
        expect(query.include_raw_content).toBe(false); expect(query.max_results).toBe(4);
        const domain = query.include_domains[0]; domains.push(domain);
        return json({ results: Array.from({ length: 4 }, (_, index) => ({ title: 'Python Intern at Example Employer', url: urlFor(domain, index), content: 'Search snippet.', raw_content: 'A fabricated cached JD with Java only. This vacancy has now expired.' })) });
      }
      details++;
      if (/api\.lever|boards-api\.greenhouse/.test(url.hostname)) return json({ title: 'Python Intern', text: 'Python Intern', content: description, descriptionPlain: description, categories: { commitment: 'Internship' } });
      return new Response(`<script>${'&lt;unused&amp;script&gt;'.repeat(4000)}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Python Intern', hiringOrganization: { name: 'Example Employer' }, description, employmentType: 'INTERN' })}</script><article>${description}</article>`);
    }));
    const jobs = await discoverJobs(env, { mode: 'internship', skills: ['Python'] }, { warn() {}, report: rows => { sources = rows; } });
    expect(domains).toEqual(['internshala.com', 'wellfound.com', 'job-boards.greenhouse.io', 'jobs.lever.co', 'linkedin.com']);
    expect(jobs).toHaveLength(8); expect(details).toBe(8);
    expect(jobs.every(job => job.description === description)).toBe(true);
    expect(sources.every(source => source.search_calls === 1 && source.verified > 0)).toBe(true);
    expect(JSON.stringify(jobs)).not.toContain('fabricated cached JD');
  });

  it('still rejects a visible expired banner after a large entity-heavy invisible script', async () => {
    vi.stubGlobal('fetch', vi.fn((raw: RequestInfo | URL) => String(raw).includes('tavily')
      ? json({ results: [{ title: 'Python Intern at Example Employer', url: 'https://wellfound.com/jobs/expired' }] })
      : new Response(`<script>${'&amp;not-visible;'.repeat(5000)}</script><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Python Intern', hiringOrganization: { name: 'Example Employer' }, description, employmentType: 'INTERN' })}</script><p>This vacancy has now expired.</p>`)));
    expect(await discoverJobs(env, { mode: 'internship' })).toEqual([]);
  });

  it('preserves escaped HTML and split multibyte source text without accepting search snippets', async () => {
    const full = `${description} Montréal mentoring with José.`, encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn((raw: RequestInfo | URL) => {
      if (String(raw).includes('tavily')) return json({ results: [{ title: 'Python Intern at Example Employer', url: 'https://job-boards.greenhouse.io/example/jobs/123', raw_content: 'Cached material must not replace the source.' }] });
      const bytes = encoder.encode(JSON.stringify({ title: 'Python Intern', content: `&amp;lt;nav&amp;gt;Hidden navigation&amp;lt;/nav&amp;gt;&amp;lt;p&amp;gt;${full}&amp;lt;/p&amp;gt;` }));
      const split = bytes.indexOf(0xc3) + 1;
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, split)); controller.enqueue(bytes.subarray(split)); controller.close(); } }));
    }));
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(1); expect(jobs[0].description).toBe(full); expect(jobs[0].description).not.toContain('Hidden navigation');
  });

  it('does not expose a dangling script or HTML comments as a vacancy banner', async () => {
    vi.stubGlobal('fetch', vi.fn((raw: RequestInfo | URL) => String(raw).includes('tavily')
      ? json({ results: [{ title: 'Python Intern at Example Employer', url: 'https://wellfound.com/jobs/active' }] })
      : new Response(`<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Python Intern', hiringOrganization: { name: 'Example Employer' }, description, employmentType: 'INTERN' })}</script><!-- This vacancy has now expired. --><article>${description}</article><script>${'<bad '.repeat(700)}${'x'.repeat(100000)} This vacancy has now expired.`)));
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(1); expect(jobs[0].description).toBe(description);
  });

  it('keeps Unicode text offsets intact around mixed-case hidden elements', async () => {
    const full = `${description} İstanbul mentor: İpek. हिंदी and Français.`, encoded = `<p>${full}</p><SCRIPT>private hidden material</ScRiPt><p>Applications open.</p>`;
    vi.stubGlobal('fetch', vi.fn((raw: RequestInfo | URL) => String(raw).includes('tavily')
      ? json({ results: [{ title: 'Python Intern at Example Employer', url: 'https://job-boards.greenhouse.io/example/jobs/123' }] })
      : json({ title: 'Python Intern', content: encoded })));
    const jobs = await discoverJobs(env, { mode: 'internship' });
    expect(jobs).toHaveLength(1); expect(jobs[0].description).toBe(`${full}\nApplications open.`);
    expect(jobs[0].description).not.toContain('hidden material');
  });
});
