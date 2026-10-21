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

vi.mock('../api/client', async importOriginal => ({ ...await importOriginal(), api: { getProfile: vi.fn(), saveProfile: vi.fn(), getPlan: vi.fn(), swapJob: vi.fn(), confirmPlan: vi.fn(), getApplications: vi.fn(), getPrepGuide: vi.fn(), getResumes: vi.fn(), getReport: vi.fn(), generateReport: vi.fn() } }));
const baseContext = { profile: null, userId: '', loading: false, error: '', activateProfile: vi.fn(), selectProfile: vi.fn(), clearProfile: vi.fn() };
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
});

it('boots the complete app, routes new users to profile, and navigates the workspace', async () => {
  const { default: App } = await import('../App');
  mount(<App />);
  expect(await screen.findByRole('heading', { name: 'A profile that feels like you.' })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('link', { name: 'Weekly plan' }));
  expect(await screen.findByRole('heading', { name: 'Your weekly plan.' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Set up profile/ })).toBeInTheDocument();
});
