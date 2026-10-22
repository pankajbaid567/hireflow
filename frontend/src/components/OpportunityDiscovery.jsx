import { useState } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { ErrorNotice } from './UI';

export default function OpportunityDiscovery({ userId, profile, onUpdated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [job, setJob] = useState({ title: '', company: '', url: '', description: '', location: '' });
  const update = event => setJob(current => ({ ...current, [event.target.name]: event.target.value }));
  async function discover() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.discoverJobs(userId);
      setMessage(result.message || `${result.imported || 0} new opportunities found.`);
      onUpdated();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function add(event) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const result = await api.addJob(userId, { ...job, listing_type: profile?.mode || 'internship' });
      setJob({ title: '', company: '', url: '', description: '', location: '' });
      setMessage(result.message || 'Opportunity added. Your plan is ready to refresh.'); onUpdated();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="panel opportunity-discovery" aria-label="Find opportunities"><div className="discovery-heading"><div><h2>Bring your next opportunity into focus.</h2><p>Search for fresh listings or add a role you already have in mind.</p></div><button className="button button-secondary button-small" disabled={busy} onClick={discover}><Search size={15} />{busy ? 'Working…' : 'Find opportunities'}</button></div>{error && <ErrorNotice>{error}</ErrorNotice>}{message && <p className="notice notice-success" role="status">{message}</p>}<details><summary>Add an opportunity <ChevronDown size={15} /></summary><form onSubmit={add}><div className="form-grid"><label>Role title<input name="title" value={job.title} onChange={update} required placeholder="AI Engineer Intern" /></label><label>Company<input name="company" value={job.company} onChange={update} required placeholder="Company name" /></label><label className="full-width">Application URL<input name="url" type="url" value={job.url} onChange={update} required placeholder="https://company.com/careers/role" /></label><label>Location<input name="location" value={job.location} onChange={update} placeholder="Remote, Bengaluru…" /></label><label className="full-width">Job description<textarea name="description" value={job.description} onChange={update} required rows={5} placeholder="Paste the role, requirements, and skills from the listing." /></label></div><button className="button button-small" disabled={busy} type="submit"><Plus size={15} />Add to opportunities</button></form></details></section>;
}
