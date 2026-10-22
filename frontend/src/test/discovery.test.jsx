import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import OpportunityDiscovery from '../components/OpportunityDiscovery';
import JobCard from '../components/JobCard';
import { api } from '../api/client';

vi.mock('../api/client', async importOriginal => ({ ...await importOriginal(), api: { discoverJobs: vi.fn(), addJob: vi.fn() } }));
beforeEach(() => { vi.clearAllMocks(); });
const job = { job_id: 1, company_name: 'Example Co', role_title: 'Python Intern', match_score: 0.85, skill_gaps: ['Docker'], location: 'Remote', listing_type: 'internship', source: 'Internshala', url: 'https://internshala.com/internship/detail/python-intern-123', resume_url: '/resumes/1/1/download' };
const renderCard = (fields = {}) => render(<JobCard job={{ ...job, ...fields }} selected onSelect={vi.fn()} onPreview={vi.fn()} onSwap={vi.fn()} />);

describe('transparent multisite discovery', () => {
  it('shows returned verified counts per source, including restricted and empty sites without inventing listings', async () => {
    api.discoverJobs.mockResolvedValue({ imported: 4, message: '4 new opportunities added; 1 was already available.', sources: [
      { id: 'internshala', name: 'Internshala', searched: 8, verified: 2, restricted: 1, status: 'ok', search_calls: 1 },
      { id: 'wellfound', name: 'Wellfound', searched: 6, verified: 3, restricted: 0, status: 'ok', search_calls: 1 },
      { id: 'linkedin', name: 'LinkedIn', searched: 4, verified: 0, restricted: 4, status: 'restricted', search_calls: 1 },
      { id: 'greenhouse', name: 'Greenhouse', searched: 0, verified: 0, restricted: 0, status: 'empty', search_calls: 1 },
      { id: 'lever', name: 'Lever', searched: 0, verified: 0, restricted: 0, status: 'unavailable', search_calls: 1 },
    ] });
    const onUpdated = vi.fn(); render(<OpportunityDiscovery userId="7" profile={{ mode: 'internship' }} onUpdated={onUpdated} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Find opportunities' }));
    expect(await screen.findByRole('status')).toHaveTextContent('4 new opportunities added');
    const internshala = screen.getByText('Internshala').closest('li'); expect(within(internshala).getByText('2 verified')).toBeInTheDocument(); expect(within(internshala).getByText('8 search results · 1 could not be accessed')).toBeInTheDocument();
    expect(within(screen.getByText('Wellfound').closest('li')).getByText('3 verified')).toBeInTheDocument();
    const linkedin = screen.getByText('LinkedIn').closest('li'); expect(within(linkedin).getByText('0 verified')).toBeInTheDocument(); expect(within(linkedin).getByText('Access restricted')).toBeInTheDocument();
    expect(screen.getByText('No verified listings')).toBeInTheDocument(); expect(screen.getByText('Search unavailable')).toBeInTheDocument();
    expect(screen.getByText(/some listings may already be/)).toBeInTheDocument();
    expect(onUpdated).toHaveBeenCalledTimes(1); expect(screen.queryByText('Python Intern')).not.toBeInTheDocument();
  });

  it('reports searching without fabricating per-site progress before the final response', async () => {
    let resolve; api.discoverJobs.mockReturnValue(new Promise(done => { resolve = done; }));
    render(<OpportunityDiscovery userId="7" profile={{}} onUpdated={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Find opportunities' }));
    expect(screen.getByRole('button', { name: 'Searching…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('verifying individual listings');
    expect(screen.queryByText('Search results by site')).not.toBeInTheDocument();
    resolve({ imported: 0, message: 'No verified opportunities found.', sources: [{ id: 'lever', name: 'Lever', searched: 0, verified: 0, restricted: 0, status: 'budget_limited', search_calls: 0 }] });
    expect(await screen.findByText('Not searched this time')).toBeInTheDocument(); expect(screen.getByText('Search limit reached')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('notice-info'); expect(screen.getByText('0 verified')).toBeInTheDocument();
  });

  it('removes previous source counts on a failed new search instead of presenting stale results', async () => {
    api.discoverJobs.mockResolvedValueOnce({ imported: 1, message: '1 opportunity added.', sources: [{ id: 'internshala', name: 'Internshala', searched: 1, verified: 1, restricted: 0, status: 'ok', search_calls: 1 }] }).mockRejectedValueOnce(new Error('Search is unavailable.'));
    const onUpdated = vi.fn(); render(<OpportunityDiscovery userId="7" profile={{}} onUpdated={onUpdated} />); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Find opportunities' })); expect(await screen.findByText('1 verified')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find opportunities' })); expect(await screen.findByRole('alert')).toHaveTextContent('Search is unavailable.');
    expect(screen.queryByText('1 verified')).not.toBeInTheDocument(); expect(screen.queryByText('Internshala')).not.toBeInTheDocument(); expect(onUpdated).toHaveBeenCalledTimes(1);
  });

  it('remains compatible with a response that does not contain source details', async () => {
    api.discoverJobs.mockResolvedValue({ imported: 2 }); render(<OpportunityDiscovery userId="7" profile={{}} onUpdated={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Find opportunities' }));
    expect(await screen.findByRole('status')).toHaveTextContent('2 new opportunities found.'); expect(screen.queryByText('Search results by site')).not.toBeInTheDocument();
  });

  it('shows the current unavailable source report alongside a 503 error without rendering results', async () => {
    const names = ['Internshala', 'Wellfound', 'Greenhouse', 'Lever', 'LinkedIn'];
    api.discoverJobs.mockRejectedValue({ response: { status: 503, data: { detail: 'Search provider is temporarily unavailable.', sources: names.map(name => ({ id: name.toLowerCase(), name, searched: 0, verified: 0, restricted: 0, status: 'unavailable', search_calls: 1 })) } } });
    const onUpdated = vi.fn(); render(<OpportunityDiscovery userId="7" profile={{}} onUpdated={onUpdated} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Find opportunities' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Search provider is temporarily unavailable.');
    expect(screen.getAllByText('Search unavailable')).toHaveLength(5);
    for (const name of names) expect(within(screen.getByText(name).closest('li')).getByText('0 verified')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument(); expect(screen.queryByRole('link', { name: 'View listing' })).not.toBeInTheDocument(); expect(onUpdated).not.toHaveBeenCalled();
  });

  it('ignores a malformed error source report after clearing the previous search', async () => {
    api.discoverJobs.mockResolvedValueOnce({ imported: 1, sources: [{ id: 'internshala', name: 'Internshala', searched: 1, verified: 1, restricted: 0, status: 'ok' }] }).mockRejectedValueOnce({ response: { status: 503, data: { detail: 'Search unavailable.', sources: { name: 'Malformed source' } } } });
    render(<OpportunityDiscovery userId="7" profile={{}} onUpdated={vi.fn()} />); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Find opportunities' })); expect(await screen.findByText('1 verified')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find opportunities' })); expect(await screen.findByRole('alert')).toHaveTextContent('Search unavailable.');
    expect(screen.queryByText('Internshala')).not.toBeInTheDocument(); expect(screen.queryByText('Search results by site')).not.toBeInTheDocument();
  });
});

describe('original listing links', () => {
  it('shows the actual source, location and type and opens the public listing safely', async () => {
    renderCard(); expect(screen.getByText('Internshala')).toBeInTheDocument(); expect(screen.getByText('Remote')).toBeInTheDocument(); expect(screen.getByText('Internship')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'View listing' }); expect(link).toHaveAttribute('href', job.url); expect(link).toHaveAttribute('target', '_blank'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
  it.each(['javascript:alert(1)', 'data:text/html,test', '//example.com/apply', 'http://localhost/apply', 'http://127.0.0.1/apply', 'http://10.2.3.4/apply', 'http://172.16.1.2/apply', 'http://192.168.0.1/apply', 'http://169.254.169.254/apply', 'http://[::1]/apply', 'https://user:password@example.com/apply', undefined])('does not create an unsafe or missing listing link for %s', url => {
    renderCard({ url }); expect(screen.queryByRole('link', { name: 'View listing' })).not.toBeInTheDocument(); expect(screen.getByRole('heading', { name: 'Python Intern' })).toBeInTheDocument();
  });
  it('does not invent a source when older cards do not provide it', () => {
    renderCard({ source: undefined, location: undefined, listing_type: 'job' }); expect(screen.queryByText('Internshala')).not.toBeInTheDocument(); expect(screen.getByText('Job')).toBeInTheDocument();
  });
});
