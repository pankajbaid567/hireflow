import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, artifactUrl, externalUrl } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import { useRemote } from '../hooks/useRemote';
import { EmptyState, ErrorNotice, formatDate, Loading, PageHeading, ProfileRequired, scorePercent, StatusBadge } from '../components/UI';

function Tracker({ userId }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useRemote(() => api.getApplications(userId, { status: status || undefined, page, page_size: 20 }), [userId, status, page]);
  const items = data?.items || [];
  useEffect(() => {
    // Poll active submissions; stop when all applications have settled.
    if (!items.some(item => ['confirmed', 'applying'].includes(item.status))) return;
    const timer = setInterval(reload, 10000);
    return () => clearInterval(timer);
  }, [data, reload]);
  return <><PageHeading eyebrow="EVERY STEP, IN ONE PLACE" title="Your applications." action={<button className="button button-secondary button-small" onClick={reload} disabled={loading}><RefreshCw size={15} />Refresh</button>}>Keep an eye on what’s moving, and see where a little attention is needed.</PageHeading><div className="panel tracker-panel"><div className="table-toolbar"><div><h2>Application activity</h2><p>{data ? `${data.total} applications in your journey` : 'Your complete application history'}</p></div><label className="filter-label">Filter by status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{['planned', 'confirmed', 'applying', 'applied', 'failed', 'needs_action'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label></div>
    {loading && <Loading label="Checking your applications…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{!loading && !error && (items.length ? <><div className="table-scroll"><table><thead><tr><th>Opportunity</th><th>Status</th><th>Match</th><th>Date</th><th>Your documents</th></tr></thead><tbody>{items.map(item => { const resume = artifactUrl(item.resume_url); const manual = externalUrl(item.manual_action_url); return <tr key={item.id} className={item.status === 'needs_action' ? 'attention-row' : ''}><td><strong>{item.role || item.role_title}</strong><span className="table-subtext">{item.company || item.company_name}</span></td><td><StatusBadge status={item.status} />{item.failure_reason && <p className="failure-reason">{item.failure_reason}</p>}{manual && <a className="manual-link" href={manual} target="_blank" rel="noopener noreferrer">Complete manually <ArrowUpRight size={14} /></a>}</td><td><span className="table-score">{scorePercent(item.match_score)}</span></td><td className="nowrap">{formatDate(item.applied_at || item.created_at)}</td><td><div className="document-links">{resume && <a href={resume} target="_blank" rel="noopener noreferrer"><ArrowDownToLine size={14} />Resume</a>}<Link to={`/applications/${item.id}/prep-guide`}><BookOpen size={14} />Prep guide</Link>{!resume && <span className="muted">Resume pending</span>}</div></td></tr>; })}</tbody></table></div><div className="pagination"><span>Page {page} of {Math.max(1, Math.ceil(data.total / 20))}</span><div className="button-row"><button className="button button-secondary button-small" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={15} />Previous</button><button className="button button-secondary button-small" disabled={page * 20 >= data.total || loading} onClick={() => setPage(p => p + 1)}>Next<ChevronRight size={15} /></button></div></div></> : <EmptyState title={status ? 'Nothing in this status yet' : 'Every journey starts somewhere'}>{status ? 'Choose a different status to see more applications.' : 'Your applications will appear here after you review your weekly plan.'}<Link to="/weekly-plan" className="button button-secondary">View weekly plan</Link></EmptyState>)}</div></>;
}
export default function ApplicationTrackerPage() { const { userId } = useProfile(); return userId ? <Tracker key={userId} userId={userId} /> : <><PageHeading eyebrow="EVERY STEP, IN ONE PLACE" title="Your applications." /><ProfileRequired /></>; }
