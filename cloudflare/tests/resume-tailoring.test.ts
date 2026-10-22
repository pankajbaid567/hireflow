import { describe, expect, it, vi } from 'vitest';
import { hasTailoringProvider, sourceFacts, tailorResume } from '../src/resume_tailoring';
import type { Env, Row } from '../src/types';

const env = { GROQ_API_KEY: 'test-key-not-a-real-credential', GROQ_MODEL: 'test-model' } as Env;
const profile: Row = {
  name: 'Example Candidate', email: 'private@example.com', phone: '9999999999', mode: 'internship',
  skills: ['Python', 'React', 'SQL', 'Docker'],
  education: [{ degree: 'BSc Computer Science', institution: 'Example College' }],
  experience: [{ title: 'Software Developer', company: 'Example Labs', bullets: ['Improved SQL report latency by 25%.', 'Built Python data checks for daily imports.'] }],
  projects: [
    { name: 'Data Explorer', description: 'Built Python dashboards for public datasets.', tech: ['Python', 'SQL'], url: 'https://example.com/data' },
    { name: 'Accessible Portfolio', description: 'Built a React portfolio with keyboard navigation.', tech: ['React'], url: 'https://example.com/portfolio' },
    { name: 'Container Toolkit', description: 'Packaged Python services with Docker for local development.', tech: ['Docker', 'Python'] },
    { name: 'Reading List', description: 'Created a book catalog with search and filters.', tech: ['JavaScript'] },
  ],
};
const job = { title: 'Data Engineer Intern', company: 'Example Co', description: 'Python SQL Docker data pipelines', listing_type: 'internship' };
const selection = { summary_fact_ids: ['project:0:fact:0', 'project:2:fact:0'], project_indices: [0, 2] };
const reply = (value: unknown, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), { status });

describe('grounded resume tailoring', () => {
  it('makes role and mode affect the selected factual summary and projects', async () => {
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body));
      const data = JSON.parse(body.messages[1].content.split('DATA:\n')[1]);
      return data.mode === 'job'
        ? reply({ summary_fact_ids: ['experience:0:fact:0'], project_indices: [0, 2] })
        : data.job.title.includes('Frontend')
          ? reply({ summary_fact_ids: ['project:1:fact:0'], project_indices: [1, 3] })
          : reply(selection);
    }) as unknown as typeof fetch;
    const data = await tailorResume(env, profile, job, ['Python', 'SQL'], { fetcher });
    const frontend = await tailorResume(env, profile, { ...job, title: 'Frontend Intern', description: 'React accessibility' }, ['React'], { fetcher });
    const experienced = await tailorResume(env, profile, { ...job, title: 'Data Engineer', listing_type: 'job' }, ['Python', 'SQL'], { fetcher });
    expect(data.metadata).toMatchObject({ method: 'llm_grounded', model: 'test-model', mode: 'internship', ...selection, warnings: [] });
    expect(data.profile.summary).toContain('Seeking an internship in Data Engineer. Built Python dashboards for public datasets.');
    expect(frontend.profile.summary).toContain('Built a React portfolio with keyboard navigation.');
    expect(frontend.profile.projects).toEqual([profile.projects[1], profile.projects[3]]);
    expect(experienced.profile.summary).toBe('Focused on Data Engineer opportunities. Improved SQL report latency by 25%.');
    expect(experienced.metadata.mode).toBe('job');
  });

  it('copies original selected entries and source facts without accepting authored claims', async () => {
    const original = structuredClone(profile);
    const tailored = await tailorResume(env, profile, job, ['Python'], { fetcher: vi.fn(async () => reply({ ...selection, summary: 'Invented 12 years at Google', bullets: ['Invented achievement'] })) as typeof fetch });
    expect(tailored.profile.experience).toEqual(original.experience);
    expect(tailored.profile.education).toEqual(original.education);
    expect(tailored.profile.projects).toEqual([original.projects[0], original.projects[2]]);
    expect(tailored.profile.summary).not.toMatch(/Invented|Google|12 years/);
    expect(profile).toEqual(original);
    for (const id of tailored.metadata.summary_fact_ids) expect(tailored.profile.summary).toContain(sourceFacts(profile).find(f => f.id === id)!.text);
  });

  it('uses a fixed endpoint, bounded prompt and JSON selection without contact details', async () => {
    const fetcher = vi.fn(async () => reply(selection));
    await tailorResume(env, profile, { ...job, description: 'x'.repeat(30000) }, ['Python'], { fetcher: fetcher as typeof fetch });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(String(init.body));
    const prompt = body.messages[1].content;
    expect(prompt).not.toMatch(/private@example.com|9999999999|Example Candidate/);
    expect(JSON.parse(prompt.split('DATA:\n')[1]).job.description).toHaveLength(9000);
    expect(body).toMatchObject({ model: 'test-model', response_format: { type: 'json_object' }, max_completion_tokens: 800 });
  });

  it.each([
    { summary_fact_ids: ['fake:invented'], project_indices: [0, 2] },
    { summary_fact_ids: ['project:0:fact:0'], project_indices: [0, 99] },
    { summary_fact_ids: ['project:0:fact:0'], project_indices: [0, 0] },
    { summary_fact_ids: [], project_indices: [0, 2] },
    { summary_fact_ids: ['project:0:fact:0', 'project:0:fact:0'], project_indices: [0, 2] },
    { summary_fact_ids: ['project:0:fact:0'], project_indices: [0] },
  ])('rejects unsafe or incomplete selection %# and reports a truthful fallback', async value => {
    const tailored = await tailorResume(env, profile, job, ['Python'], { fetcher: vi.fn(async () => reply(value)) as typeof fetch });
    expect(tailored.metadata).toMatchObject({ method: 'deterministic', model: null, reason: 'invalid_selection' });
    expect(tailored.metadata.warnings).toHaveLength(1);
    expect(tailored.profile.projects).toHaveLength(3);
    expect(tailored.profile.summary).not.toContain('invented');
  });

  it('does not call a provider with an unconfigured key and uses the current role and mode offline', async () => {
    const fetcher = vi.fn();
    const internship = await tailorResume({} as Env, profile, job, ['Python'], { fetcher });
    const fulltime = await tailorResume({ GROQ_API_KEY: 'placeholder' } as Env, profile, { ...job, listing_type: 'job' }, ['SQL'], { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(internship.metadata.reason).toBe('provider_unconfigured');
    expect(internship.profile.summary).toContain('Built Python dashboards');
    expect(fulltime.profile.summary).toContain('Improved SQL report latency by 25%.');
    expect(hasTailoringProvider({ GROQ_API_KEY: ' none ' } as Env)).toBe(false);
  });

  it('never infers professional years or missing skills from a job description', async () => {
    const small = { skills: ['Python'], projects: [], mode: 'internship' };
    const fetcher = vi.fn();
    const result = await tailorResume(env, small, { ...job, description: 'Requires 10 years Kubernetes' }, ['Python', 'Kubernetes'], { fetcher });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.profile.summary).toBe('Seeking an internship in Data Engineer. Technical background includes Python.');
    expect(result.metadata.reason).toBe('no_source_facts');
  });

  it.each([301, 429, 503])('degrades cleanly on provider HTTP %s without following redirects', async status => {
    const result = await tailorResume(env, profile, job, ['Python'], { fetcher: vi.fn(async () => new Response('provider error', { status })) as typeof fetch });
    expect(result.metadata).toMatchObject({ method: 'deterministic', reason: 'provider_unavailable' });
  });

  it('aborts a timed out provider and returns a factual fallback', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init!.signal as AbortSignal;
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const result = await tailorResume(env, profile, job, ['Python'], { fetcher: fetcher as typeof fetch, timeoutMs: 5 });
    expect(signal!.aborted).toBe(true);
    expect(result.metadata).toMatchObject({ method: 'deterministic', reason: 'provider_timeout' });
  });

  it.each(['not JSON', 'x'.repeat(66000)])('bounds and rejects invalid provider response bodies %#', async body => {
    const result = await tailorResume(env, profile, job, ['Python'], { fetcher: vi.fn(async () => new Response(body)) as typeof fetch });
    expect(result.metadata.method).toBe('deterministic');
    expect(result.metadata.reason).toBe('invalid_selection');
  });

  it('accepts fewer projects when the factual profile only contains one', async () => {
    const one = { ...profile, projects: [profile.projects[0]] };
    const result = await tailorResume(env, one, job, ['Python'], { fetcher: vi.fn(async () => reply({ summary_fact_ids: ['project:0:fact:0'], project_indices: [0] })) as typeof fetch });
    expect(result.metadata.method).toBe('llm_grounded');
    expect(result.profile.projects).toEqual(one.projects);
  });
});
