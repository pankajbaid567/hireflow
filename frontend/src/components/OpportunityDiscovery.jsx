import { useState } from 'react';
import { ChevronDown, Plus, Search } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { ErrorNotice } from './UI';

export default function OpportunityDiscovery({ userId, profile, onUpdated }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [sources, setSources] = useState([]);
  const [imported, setImported] = useState(null);
  const [job, setJob] = useState({ title: '', company: '', url: '', description: '', location: '' });
  const update = event => setJob(current => ({ ...current, [event.target.name]: event.target.value }));
  async function discover() {
    setBusy('search'); setError(''); setMessage(''); setSources([]); setImported(null);
    try {
      const result = await api.discoverJobs(userId);
      setMessage(result.message || `${result.imported || 0} new opportunities found.`);
      setImported(result.imported || 0);
      setSources(Array.isArray(result.sources) ? result.sources : []);
      onUpdated();
    } catch (error) {
      setError(errorMessage(error));
      if (Array.isArray(error.response?.data?.sources)) setSources(error.response.data.sources);
    }
    finally { setBusy(''); }
  }
  async function add(event) {
    event.preventDefault(); setBusy('add'); setError(''); setMessage(''); setSources([]); setImported(null);
    try {
      const result = await api.addJob(userId, { ...job, listing_type: profile?.mode || 'internship' });
      setJob({ title: '', company: '', url: '', description: '', location: '' });
      setMessage(result.message || 'Opportunity added. Your plan is ready to refresh.'); onUpdated();
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(''); }
  }
  return <section className="panel opportunity-discovery" aria-label="Find opportunities"><div className="discovery-heading"><div><h2>Bring your next opportunity into focus.</h2><p>Search across job sites or add a role you already have in mind.</p></div><button className="button button-secondary button-small" disabled={Boolean(busy)} onClick={discover}><Search size={15} />{busy === 'search' ? 'Searching…' : 'Find opportunities'}</button></div>{busy === 'search' && <p className="notice notice-info" role="status">Searching across job sites and verifying individual listings. Results appear after verification.</p>}{error && <ErrorNotice>{error}</ErrorNotice>}{message && <p className={`notice ${imported === 0 ? 'notice-info' : 'notice-success'}`} role="status">{message}</p>}{sources.length > 0 && <SourceResults sources={sources} />}<details><summary>Add an opportunity <ChevronDown size={15} /></summary><form onSubmit={add}><div className="form-grid"><label>Role title<input name="title" value={job.title} onChange={update} required placeholder="AI Engineer Intern" /></label><label>Company<input name="company" value={job.company} onChange={update} required placeholder="Company name" /></label><label className="full-width">Application URL<input name="url" type="url" value={job.url} onChange={update} required placeholder="https://company.com/careers/role" /></label><label>Location<input name="location" value={job.location} onChange={update} placeholder="Remote, Bengaluru…" /></label><label className="full-width">Job description<textarea name="description" value={job.description} onChange={update} required rows={5} placeholder="Paste the role, requirements, and skills from the listing." /></label></div><button className="button button-small" disabled={Boolean(busy)} type="submit"><Plus size={15} />{busy === 'add' ? 'Adding…' : 'Add to opportunities'}</button></form></details></section>;
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const sourceStatus = { empty: 'No verified listings', restricted: 'Access restricted', unavailable: 'Search unavailable', budget_limited: 'Verification limit reached' };
function SourceResults({ sources }) {
  return <div className="discovery-results" aria-label="Search results by site"><h3>Search results by site</h3><p>Verified counts describe this search; some listings may already be in your opportunities.</p><ul>{sources.filter(source => source && typeof source.name === 'string').map((source, index) => <li key={source.id || index}><div><strong>{source.name}</strong><span>{source.search_calls === 0 ? 'Not searched this time' : `${count(source.searched)} search results`}{count(source.restricted) > 0 && ` · ${count(source.restricted)} could not be accessed`}</span></div><div className="discovery-source-result"><strong>{count(source.verified)} verified</strong>{sourceStatus[source.status] && <span>{source.status === 'budget_limited' && source.search_calls === 0 ? 'Search limit reached' : sourceStatus[source.status]}</span>}</div></li>)}</ul></div>;
}
