import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProfileContext } from '../context/ProfileContext';
import { api } from '../api/client';
import ProfilePage from '../pages/ProfilePage';
import WeeklyPlanPage from '../pages/WeeklyPlanPage';
import ApplicationTrackerPage from '../pages/ApplicationTrackerPage';
import PrepGuidePage from '../pages/PrepGuidePage';
import ResumeLibraryPage from '../pages/ResumeLibraryPage';
import ReportsPage from '../pages/ReportsPage';

vi.mock('../api/client', async importOriginal => ({ ...await importOriginal(), api: { getProfile: vi.fn(), saveProfile: vi.fn(), getPlan: vi.fn(), swapJob: vi.fn(), confirmPlan: vi.fn(), getApplications: vi.fn(), getPrepGuide: vi.fn(), getResumes: vi.fn(), getReport: vi.fn(), generateReport: vi.fn(), getSession: vi.fn(), logoutSession: vi.fn(), discoverJobs: vi.fn(), addJob: vi.fn() } }));
const baseContext = { profile: null, userId: '', loading: false, error: '', activateProfile: vi.fn(), selectProfile: vi.fn(), clearProfile: vi.fn(), logoutProfile: vi.fn() };
const saved = { id: 7, name: 'Alex Morgan', email: 'alex@example.com', mode: 'internship', weekly_quota: 10, master_profile: { skills: ['Python'] } };
function mount(component, context = {}, path = '/') { return render(<MemoryRouter initialEntries={[path]}><ProfileContext.Provider value={{ ...baseContext, ...context }}>{component}</ProfileContext.Provider></MemoryRouter>); }
beforeEach(() => { vi.clearAllMocks(); });

describe('profile setup', () => {
  it('submits the selected opportunity mode and parsed skills to the API', async () => {
    api.saveProfile.mockResolvedValue(saved);
    const activateProfile = vi.fn(); mount(<ProfilePage />, { activateProfile });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
    await user.type(screen.getByLabelText('Email address'), 'alex@example.com');
    await user.type(screen.getByLabelText(/^Skills/), 'Python, React');
    await user.click(screen.getByRole('radio', { name: /Job Your next chapter/ }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ name: 'Alex Morgan', skills: ['Python', 'React'], mode: 'job', weekly_quota: 10 }), undefined));
    expect(activateProfile).toHaveBeenCalledWith(saved);
    expect(await screen.findByRole('status')).toHaveTextContent('Profile saved');
  });
  it('sends a PDF together with explicit form values and edits an existing profile', async () => {
    api.saveProfile.mockResolvedValue(saved); mount(<ProfilePage />, { profile: saved, userId: '7' });
    const user = userEvent.setup(); const pdf = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), pdf);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalled());
    const [payload, id] = api.saveProfile.mock.calls[0];
    expect(id).toBe(7); expect(payload).toBeInstanceOf(FormData); expect(payload.get('resume')).toBe(pdf); expect(payload.get('skills')).toBe('["Python"]'); expect(payload.get('mode')).toBe('internship');
  });
  it.each([
    ['object with JSON', { degree: 'BSc Computer Science', institution: 'Example University', year: '2026' }, false],
    ['array with JSON', [{ degree: 'BSc Computer Science', institution: 'Example University', year: '2026' }], false],
    ['object with multipart', { degree: 'BSc Computer Science', institution: 'Example University', year: '2026' }, true],
    ['array with multipart', [{ degree: 'BSc Computer Science', institution: 'Example University', year: '2026' }], true],
  ])('shows readable education and preserves untouched structured %s on preference saves', async (_label, education, withResume) => {
    const profile = { ...saved, master_profile: { ...saved.master_profile, education } };
    api.saveProfile.mockResolvedValue(profile); mount(<ProfilePage />, { profile, userId: '7' }); const user = userEvent.setup();
    expect(screen.getByLabelText('Education')).toHaveValue('BSc Computer Science, Example University, 2026');
    await user.clear(screen.getByLabelText(/^Applications per week/)); await user.type(screen.getByLabelText(/^Applications per week/), '3');
    if (withResume) await user.upload(screen.getByLabelText('Resume PDF'), new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1));
    const [payload] = api.saveProfile.mock.calls[0];
    expect(withResume ? JSON.parse(payload.get('education')) : payload.education).toEqual(education);
    expect(withResume ? payload.get('weekly_quota') : payload.weekly_quota).toBe(withResume ? '3' : 3);
  });
  it.each([false, true])('sends edited education as plain text (resume upload: %s)', async withResume => {
    const profile = { ...saved, master_profile: { ...saved.master_profile, education: [{ degree: 'BSc', institution: 'Example University', year: '2026' }] } };
    api.saveProfile.mockResolvedValue(profile); mount(<ProfilePage />, { profile, userId: '7' }); const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Education')); await user.type(screen.getByLabelText('Education'), 'MSc, New University, 2028');
    if (withResume) await user.upload(screen.getByLabelText('Resume PDF'), new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1)); const [payload] = api.saveProfile.mock.calls[0];
    expect(withResume ? payload.get('education') : payload.education).toBe('MSc, New University, 2028');
  });
  it.each([400, 500])('keeps form usable after a %s API error', async status => {
    api.saveProfile.mockRejectedValue({ response: { status, data: { detail: 'Profile could not be saved.' } } });
    mount(<ProfilePage />, { profile: saved, userId: '7' });
    const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Profile could not be saved.');
    expect(screen.getByRole('button', { name: 'Save profile' })).toBeEnabled();
    expect(screen.getByLabelText('Full name')).toHaveValue('Alex Morgan');
  });
  it('opens an existing profile by its ID', async () => {
    const selectProfile = vi.fn().mockResolvedValue(saved); mount(<ProfilePage />, { selectProfile });
    const user = userEvent.setup(); await user.type(screen.getByLabelText('Profile ID'), '7'); await user.click(screen.getByRole('button', { name: /Open profile/ }));
    expect(selectProfile).toHaveBeenCalledWith('7'); expect(await screen.findByRole('status')).toHaveTextContent('Profile opened');
  });
  it('edits structured experience and projects with multiline highlights and technology lists', async () => {
    const profile = { ...saved, master_profile: { ...saved.master_profile, experience: [{ role: 'Intern', company: 'Example Lab', bullets: ['Built an API'], dates: '2025', location: 'Remote' }], projects: [] } };
    api.saveProfile.mockResolvedValue(profile); mount(<ProfilePage />, { profile, userId: '7' }); const user = userEvent.setup();
    expect(screen.getByLabelText('Experience 1 role')).toHaveValue('Intern');
    await user.clear(screen.getByLabelText('Experience 1 role')); await user.type(screen.getByLabelText('Experience 1 role'), 'Backend Intern');
    await user.clear(screen.getByLabelText('Experience 1 highlights')); await user.type(screen.getByLabelText('Experience 1 highlights'), 'Built APIs{enter}Added tests');
    await user.click(screen.getByRole('button', { name: 'Add project', exact: true }));
    await user.type(screen.getByLabelText('Project 1 name'), 'Course Archive'); await user.type(screen.getByLabelText('Project 1 technologies'), 'Python, SQL');
    await user.type(screen.getByLabelText('Project 1 description'), 'A searchable course archive.');
    await user.click(screen.getByRole('button', { name: 'Save profile', exact: true }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1)); const [payload] = api.saveProfile.mock.calls[0];
    expect(payload.experience[0]).toEqual({ title: 'Backend Intern', company: 'Example Lab', bullets: ['Built APIs', 'Added tests'], dates: '2025', location: 'Remote' });
    expect(payload.projects[0]).toMatchObject({ name: 'Course Archive', tech: ['Python', 'SQL'], description: 'A searchable course archive.' });
  });
  it('saves summary, portfolio, compensation, excluded companies and review preferences', async () => {
    api.saveProfile.mockResolvedValue(saved); mount(<ProfilePage />, { profile: saved, userId: '7' }); const user = userEvent.setup();
    await user.type(screen.getByLabelText('Professional summary'), 'Built Python APIs for a college project.');
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true }));
    await user.type(screen.getByLabelText('Link 1 label'), 'Portfolio'); await user.type(screen.getByLabelText('Link 1 URL'), 'https://portfolio.example.com');
    await user.type(screen.getByLabelText(/^Minimum stipend/), '15000');
    await user.click(screen.getByRole('radio', { name: /Job Your next chapter/ }));
    await user.type(screen.getByLabelText(/^Minimum salary/), '600000');
    await user.type(screen.getByLabelText(/^Excluded companies/), 'Example Co, Other Co');
    await user.selectOptions(screen.getByLabelText(/^Review applications/), 'individual');
    await user.type(screen.getByLabelText('Certifications'), 'Cloud Basics{enter}API Fundamentals');
    await user.type(screen.getByLabelText('Spoken languages'), 'English, Hindi');
    await user.click(screen.getByRole('button', { name: 'Save profile', exact: true }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1));
    expect(api.saveProfile.mock.calls[0][0]).toMatchObject({ summary: 'Built Python APIs for a college project.', links: [{ label: 'Portfolio', url: 'https://portfolio.example.com' }], min_stipend: 15000, min_salary: 600000, blacklist_companies: ['Example Co', 'Other Co'], confirmation_mode: 'individual', certifications: ['Cloud Basics', 'API Fundamentals'], languages: ['English', 'Hindi'] });
  });
  it('rejects credential-bearing links before saving and removes empty detail cards cleanly', async () => {
    mount(<ProfilePage />, { profile: saved, userId: '7' }); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add experience', exact: true })); await user.click(screen.getByRole('button', { name: 'Remove experience 1', exact: true }));
    expect(screen.queryByLabelText('Experience 1 role')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add link', exact: true })); await user.type(screen.getByLabelText('Link 1 URL'), 'https://user:password@example.com');
    await user.click(screen.getByRole('button', { name: 'Save profile', exact: true }));
    expect(await screen.findByRole('alert')).toHaveTextContent('valid HTTP or HTTPS URL'); expect(api.saveProfile).not.toHaveBeenCalled();
  });
  it('clears saved compensation minimums while uploading a replacement PDF without sending literal null', async () => {
    const profile = { ...saved, master_profile: { ...saved.master_profile, min_stipend: 15000, min_salary: 600000 } };
    api.saveProfile.mockResolvedValue(profile); mount(<ProfilePage />, { profile, userId: '7' }); const user = userEvent.setup();
    await user.clear(screen.getByLabelText(/^Minimum stipend/));
    await user.click(screen.getByRole('radio', { name: /Job Your next chapter/ })); await user.clear(screen.getByLabelText(/^Minimum salary/));
    await user.upload(screen.getByLabelText('Resume PDF'), new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Save profile', exact: true }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1)); const [payload] = api.saveProfile.mock.calls[0];
    expect(payload).toBeInstanceOf(FormData); expect(payload.get('min_stipend')).toBe(''); expect(payload.get('min_salary')).toBe('');
  });
});
const firstJob = { job_id: 11, application_id: 21, company_name: 'AIBridge', role_title: 'AI Intern', match_score: 88, skill_gaps: ['Docker'], resume_url: '/resumes/7/21/download' };
const secondJob = { job_id: 12, application_id: 22, company_name: 'NextCo', role_title: 'Backend Intern', match_score: 82, skill_gaps: [] };
const replacement = { job_id: 13, company_name: 'FreshCo', role_title: 'Data Intern', match_score: 80, skill_gaps: [] };
describe('weekly plan', () => {
  it('requires a profile before requesting a plan', () => {
    mount(<WeeklyPlanPage />); expect(screen.getByRole('link', { name: /Set up profile/ })).toHaveAttribute('href', '/profile'); expect(api.getPlan).not.toHaveBeenCalled();
  });
  it('previews the actual PDF and confirms only selected opportunities', async () => {
    api.getPlan.mockResolvedValue({ plan: [firstJob, secondJob], quota: 10, alternatives: [replacement] });
    api.confirmPlan.mockResolvedValue({ message: 'Applications confirmed.' });
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Preview resume' }));
    const dialog = screen.getByRole('dialog'); expect(within(dialog).getByTitle('AIBridge · Tailored resume')).toHaveAttribute('src', '/api/resumes/7/21/download');
    await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Include Backend Intern' }));
    await user.click(screen.getByRole('button', { name: 'Confirm and Apply' }));
    await waitFor(() => expect(api.confirmPlan).toHaveBeenCalledWith('7', [11]));
    expect(await screen.findByRole('status')).toHaveTextContent('Applications confirmed.');
    expect(screen.queryByRole('heading', { name: 'AI Intern' })).not.toBeInTheDocument();
  });
  it('swaps an opportunity using the ranked alternatives', async () => {
    api.getPlan.mockResolvedValue({ plan: [firstJob], alternatives: [replacement] });
    api.swapJob.mockResolvedValue({ plan: [replacement], alternatives: [firstJob] });
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Swap AI Intern' }), '13');
    expect(api.swapJob).toHaveBeenCalledWith('7', 11, 13); expect(await screen.findByRole('heading', { name: 'Data Intern' })).toBeInTheDocument();
  });
  it('confirms exactly one selected listing when the user chooses individual review', async () => {
    api.getPlan.mockResolvedValue({ plan: [firstJob, secondJob], alternatives: [], confirmation_mode: 'individual' }); api.confirmPlan.mockResolvedValue({ message: 'One application queued.' });
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    const first = await screen.findByRole('checkbox', { name: 'Include AI Intern' }); const second = screen.getByRole('checkbox', { name: 'Include Backend Intern' });
    expect(first).toBeChecked(); expect(second).not.toBeChecked(); await user.click(second); expect(first).not.toBeChecked(); expect(second).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Confirm this opportunity', exact: true }));
    await waitFor(() => expect(api.confirmPlan).toHaveBeenCalledWith('7', [12]));
    expect(await screen.findByRole('heading', { name: 'AI Intern', exact: true })).toBeInTheDocument();
  });
  it('persists a company exclusion, refreshes the plan, and preserves the returned profile facts', async () => {
    const fullProfile = { ...saved, master_profile: { ...saved.master_profile, projects: [{ name: 'Original project', description: 'A factual original project.' }], blacklist_companies: ['Already excluded'] } };
    const updated = { ...fullProfile, master_profile: { ...fullProfile.master_profile, blacklist_companies: ['Already excluded', 'AIBridge'] } };
    const activateProfile = vi.fn();
    api.getPlan.mockResolvedValueOnce({ plan: [firstJob, secondJob], alternatives: [] }).mockResolvedValue({ plan: [secondJob], alternatives: [] });
    api.saveProfile.mockResolvedValue(updated);
    mount(<WeeklyPlanPage />, { userId: '7', profile: fullProfile, activateProfile }); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Exclude AIBridge from future plans' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledWith({ blacklist_companies: ['Already excluded', 'AIBridge'] }, '7'));
    expect(activateProfile).toHaveBeenCalledWith(updated);
    expect(updated.master_profile.projects).toEqual(fullProfile.master_profile.projects);
    expect(await screen.findByRole('status')).toHaveTextContent('AIBridge is excluded from future weekly plans');
    expect(screen.queryByRole('heading', { name: 'AI Intern', exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Backend Intern', exact: true })).toBeInTheDocument();
    expect(api.confirmPlan).not.toHaveBeenCalled();
  });
  it('keeps the current plan visible when saving an exclusion fails', async () => {
    api.getPlan.mockResolvedValue({ plan: [firstJob], alternatives: [] }); api.saveProfile.mockRejectedValue(new Error('Exclusion could not be saved.'));
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Exclude AIBridge from future plans' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Exclusion could not be saved.');
    expect(screen.getByRole('heading', { name: 'AI Intern', exact: true })).toBeInTheDocument();
    expect(api.confirmPlan).not.toHaveBeenCalled();
  });
  it('lets the user inspect the actual fact-grounded resume summary and its provenance', async () => {
    api.getPlan.mockResolvedValue({ plan: [{ ...firstJob, resume_summary: 'Seeking an internship in AI. Built Python data checks.', resume_tailoring: { method: 'llm_grounded' } }], alternatives: [] });
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    const focus = await screen.findByText('AI-selected facts'); await user.click(focus.closest('summary'));
    expect(screen.getByText('Seeking an internship in AI. Built Python data checks.')).toBeVisible();
  });
});
describe('application tracker', () => {
  it('shows manual recovery instructions and supports pagination and filtering', async () => {
    api.getApplications.mockImplementation((id, params) => Promise.resolve({ total: 21, page: params.page, items: [{ id: params.page, role: 'AI Intern', company: 'AIBridge', status: 'needs_action', match_score: 88, failure_reason: 'CAPTCHA detected', manual_action_url: 'https://example.com/apply', resume_url: '/resumes/7/21/download', created_at: '2026-10-21' }] }));
    mount(<ApplicationTrackerPage />, { userId: '7' }); const user = userEvent.setup();
    expect(await screen.findByText('CAPTCHA detected')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Complete manually/ })).toHaveAttribute('href', 'https://example.com/apply');
    await user.click(screen.getByRole('button', { name: /Next/ }));
    await waitFor(() => expect(api.getApplications).toHaveBeenCalledWith('7', expect.objectContaining({ page: 2 })));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by status' }), 'needs_action');
    await waitFor(() => expect(api.getApplications).toHaveBeenCalledWith('7', expect.objectContaining({ status: 'needs_action', page: 1 })));
  });
});
describe('prep guide and library', () => {
  it('renders topic groups, safe external resources, and questions that expand on demand', async () => {
    api.getPrepGuide.mockResolvedValue({ company: 'AIBridge', rounds: [{ number: 1, type: 'Technical', focus: 'Python and RAG' }], topics: { strong: ['Python'], moderate: ['LangChain'], gaps: ['Docker'] }, resources: { Docker: [{ title: 'Docker docs', url: 'https://docs.docker.com' }, { title: 'Unsafe resource', url: 'javascript:alert(1)' }] }, questions: [{ category: 'technical', question: 'How would you retrieve documents for RAG?' }], company_intel: {} });
    mount(<Routes><Route path="/applications/:applicationId/prep-guide" element={<PrepGuidePage />} /></Routes>, {}, '/applications/21/prep-guide');
    expect(await screen.findByText('Python')).toHaveClass('topic-strong'); expect(screen.getByText('LangChain')).toHaveClass('topic-moderate'); expect(screen.getByText('Docker', { selector: '.topic-badge' })).toHaveClass('topic-gap');
    expect(screen.getByRole('link', { name: /Docker docs/ })).toHaveAttribute('target', '_blank'); expect(screen.queryByRole('link', { name: 'Unsafe resource' })).not.toBeInTheDocument();
    const question = screen.getByText('How would you retrieve documents for RAG?'); expect(question.closest('details')).not.toHaveAttribute('open');
    await userEvent.setup().click(screen.getByText('technical question')); expect(question.closest('details')).toHaveAttribute('open');
  });
  it('lists resume versions with working API-prefixed downloads', async () => {
    api.getResumes.mockResolvedValue({ items: [{ application_id: 21, company: 'AIBridge', role: 'AI Intern', version: 2, generated_at: '2026-10-21', download_url: '/resumes/7/21/download?version=2' }] });
    mount(<ResumeLibraryPage />, { userId: '7' }); expect(await screen.findByText('Version 2')).toBeInTheDocument(); expect(screen.getByRole('link', { name: 'Download PDF' })).toHaveAttribute('href', '/api/resumes/7/21/download?version=2');
  });
  it('generates a report and opens its HTML artifact', async () => {
    api.getReport.mockResolvedValue(null); api.generateReport.mockResolvedValue({ week_start: '2026-10-19', applied_count: 3, avg_match_score: 82, html_url: '/report/7/latest/html' });
    mount(<ReportsPage />, { userId: '7' }); await userEvent.setup().click(screen.getByRole('button', { name: /Generate this week/ }));
    expect(api.generateReport).toHaveBeenCalledWith('7'); expect(await screen.findByRole('link', { name: /Open weekly report/ })).toHaveAttribute('href', '/api/report/7/latest/html');
  });
  it('clears an obsolete missing-report alert after generating the first report', async () => {
    api.getReport.mockRejectedValue({ response: { status: 404, data: { detail: 'No weekly report generated yet.' } } });
    api.generateReport.mockResolvedValue({ week_start: '2026-10-19', applied_count: 1, avg_match_score: 88, html_url: '/report/7/latest/html' });
    mount(<ReportsPage />, { userId: '7' });
    expect(await screen.findByRole('alert')).toHaveTextContent('No weekly report generated yet.');
    await userEvent.setup().click(screen.getByRole('button', { name: /Generate this week/ }));
    expect(await screen.findByRole('link', { name: /Open weekly report/ })).toHaveAttribute('href', '/api/report/7/latest/html');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

it('boots the complete app, routes new users to profile, and navigates the workspace', async () => {
  const { default: App } = await import('../App');
  mount(<App />);
  expect(await screen.findByRole('heading', { name: 'A profile that feels like you.' })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('link', { name: 'Weekly plan' }));
  expect(await screen.findByRole('heading', { name: 'Your weekly plan.' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Set up profile/ })).toBeInTheDocument();
});

describe('private Cloudflare workspace', () => {
  beforeEach(() => { vi.stubEnv('VITE_DEPLOYMENT_TARGET', 'cloudflare'); });
  it('creates a profile with a resume without access-code or ID-login controls', async () => {
    api.saveProfile.mockResolvedValue(saved); mount(<ProfilePage />); const user = userEvent.setup();
    expect(screen.queryByLabelText('Profile ID')).not.toBeInTheDocument();
    expect(screen.queryByText(/access code/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open private workspace/ })).not.toBeInTheDocument();
    expect(screen.getByText('Your profile is saved securely in this browser.')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Full name'), 'Alex Morgan');
    await user.type(screen.getByLabelText('Email address'), 'alex@example.com');
    const pdf = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), pdf);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1));
    const args = api.saveProfile.mock.calls[0];
    expect(args).toHaveLength(2); expect(args[1]).toBeUndefined();
    expect(args[0]).toBeInstanceOf(FormData); expect(args[0].get('resume')).toBe(pdf); expect(args[0].get('email')).toBe('alex@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Profile saved. Your private workspace is ready.');
    expect(localStorage.length).toBe(0);
  });
  it('shows a saved cloud profile without a numeric ID or recovery form', () => {
    mount(<ProfilePage />, { profile: saved, userId: '7' });
    expect(screen.queryByText('ID 7')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/sign in/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/access code/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });
  it('starts from a PDF alone and omits blank fields so extracted facts survive', async () => {
    api.saveProfile.mockResolvedValue(saved); mount(<ProfilePage />); const user = userEvent.setup();
    expect(screen.getByRole('heading', { name: 'Upload your resume to fill your profile' })).toBeInTheDocument();
    expect(screen.getByLabelText('Full name')).toBeRequired(); expect(screen.getByLabelText('Email address')).toBeRequired();
    const pdf = new File(['%PDF-1.4'], 'resume.pdf', { type: 'application/pdf' });
    await user.upload(screen.getByLabelText('Resume PDF'), pdf);
    expect(screen.getByLabelText('Full name')).not.toBeRequired(); expect(screen.getByLabelText('Email address')).not.toBeRequired();
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await waitFor(() => expect(api.saveProfile).toHaveBeenCalledTimes(1));
    const [data] = api.saveProfile.mock.calls[0]; expect(data.get('resume')).toBe(pdf);
    for (const key of ['name', 'email', 'phone', 'skills', 'education', 'experience_years']) expect(data.has(key)).toBe(false);
    expect(data.get('mode')).toBe('internship'); expect(data.get('weekly_quota')).toBe('10');
    expect(await screen.findByRole('status')).toHaveTextContent('Profile saved.');
  });
  it('signs out through the session endpoint', async () => {
    const logoutProfile = vi.fn().mockResolvedValue(); mount(<ProfilePage />, { profile: saved, userId: '7', logoutProfile });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(logoutProfile).toHaveBeenCalled(); expect(await screen.findByRole('status')).toHaveTextContent('signed out');
  });
  it('limits cloud resume uploads to 3 MB before calling the API', async () => {
    mount(<ProfilePage />, { profile: saved, userId: '7' }); const user = userEvent.setup();
    await user.upload(screen.getByLabelText('Resume PDF'), new File([new Uint8Array(3 * 1024 * 1024 + 1)], 'resume.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('smaller than 3 MB'); expect(api.saveProfile).not.toHaveBeenCalled();
  });
  it('offers only the configured HTTPS workspace migration origin without an ID or code login', () => {
    vi.stubEnv('VITE_PREVIOUS_DASHBOARD_URL', 'https://old-dashboard.example.com'); mount(<ProfilePage />);
    expect(screen.getByRole('link', { name: /Continue an existing workspace/ })).toHaveAttribute('href', 'https://old-dashboard.example.com/api/workspace-migrate');
    expect(screen.queryByLabelText(/access code|Profile ID/i)).not.toBeInTheDocument();
  });
  it('ignores unsafe previous-dashboard configuration', () => {
    vi.stubEnv('VITE_PREVIOUS_DASHBOARD_URL', 'https://user:password@old-dashboard.example.com'); mount(<ProfilePage />);
    expect(screen.queryByRole('link', { name: /Continue an existing workspace/ })).not.toBeInTheDocument();
  });
  it('finds opportunities and supports adding a specific job description', async () => {
    api.getPlan.mockResolvedValue({ plan: [], alternatives: [] }); api.discoverJobs.mockResolvedValue({ imported: 2, message: '2 opportunities found.' }); api.addJob.mockResolvedValue({ id: 10 });
    mount(<WeeklyPlanPage />, { userId: '7', profile: saved }); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Find opportunities' }));
    expect(api.discoverJobs).toHaveBeenCalledWith('7'); expect(await screen.findByRole('status')).toHaveTextContent('2 opportunities found');
    await user.click(screen.getByText('Add an opportunity', { selector: 'summary' }));
    await user.type(screen.getByLabelText('Role title'), 'RAG Intern'); await user.type(screen.getByLabelText('Company'), 'AIBridge');
    await user.type(screen.getByLabelText('Application URL'), 'https://example.com/jobs/rag'); await user.type(screen.getByLabelText('Job description'), 'Build RAG pipelines in Python.');
    await user.click(screen.getByRole('button', { name: 'Add to opportunities' }));
    await waitFor(() => expect(api.addJob).toHaveBeenCalledWith('7', expect.objectContaining({ title: 'RAG Intern', company: 'AIBridge', listing_type: 'internship', description: 'Build RAG pipelines in Python.' })));
  });
});

it('waits for cloud resume preparation, refreshes automatically, and enables confirmation when ready', async () => {
  vi.stubEnv('VITE_DEPLOYMENT_TARGET', 'cloudflare');
  api.getPlan.mockResolvedValueOnce({ preparing: true, warnings: ['Your resumes are being prepared.'], plan: [{ ...firstJob, resume_url: null }] })
    .mockResolvedValue({ preparing: false, warnings: [], plan: [firstJob] });
  mount(<WeeklyPlanPage />, { userId: '7', profile: saved });
  expect(await screen.findByText('Your resumes are being prepared.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Confirm and Apply' })).toBeDisabled();
  await waitFor(() => expect(api.getPlan).toHaveBeenCalledTimes(2), { timeout: 3500 });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Confirm and Apply' })).toBeEnabled());
  expect(screen.queryByText('Your resumes are being prepared.')).not.toBeInTheDocument();
});

it('shows a saved resume extraction warning so the owner can complete their profile', () => {
  vi.stubEnv('VITE_DEPLOYMENT_TARGET', 'cloudflare');
  mount(<ProfilePage />, { userId: '7', profile: { ...saved, master_profile: { ...saved.master_profile, resume_extraction_warning: 'Resume text could not be extracted. Please review your profile details.' } } });
  expect(screen.getByRole('status')).toHaveTextContent('Please review your profile details');
});
