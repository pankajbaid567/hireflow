import { useState } from 'react';
import { ArrowUpRight, CalendarDays, FilePlus2 } from 'lucide-react';
import { api, artifactUrl, errorMessage } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import { useRemote } from '../hooks/useRemote';
import { ErrorNotice, formatDate, Loading, PageHeading, ProfileRequired } from '../components/UI';
function Reports({ userId }) {
  const { data, setData, error, loading, reload } = useRemote(() => api.getReport(userId), [userId]);
  const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState('');
  async function generate() { setBusy(true); setActionError(''); try { setData(await api.generateReport(userId)); } catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); } }
  const href = artifactUrl(data?.html_url);
  return <><PageHeading eyebrow="A MOMENT TO REFLECT" title="Your weekly report." action={<button className="button button-secondary button-small" disabled={busy} onClick={generate}><FilePlus2 size={16} />{busy ? 'Generating…' : 'Generate this week'}</button>}>See what moved forward, what you learned, and where to focus next.</PageHeading>{loading && <Loading label="Finding your latest report…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{actionError && <ErrorNotice>{actionError}</ErrorNotice>}{data && <section className="panel report-panel"><span className="section-icon"><CalendarDays size={24} /></span><p className="eyebrow">WEEK OF {formatDate(data.week_start)}</p><h2>Your progress, brought together.</h2><div className="report-stats"><div><strong>{data.applied_count ?? 0}</strong><span>applications submitted</span></div><div><strong>{data.avg_match_score == null ? '—' : `${Math.round(data.avg_match_score <= 1 ? data.avg_match_score * 100 : data.avg_match_score)}%`}</strong><span>average match score</span></div></div><p>Your report brings together your applications, tailored resumes, preparation guides, and a focused study plan.</p>{href && <a href={href} target="_blank" rel="noopener noreferrer" className="button">Open weekly report <ArrowUpRight size={17} /></a>}{data.email_sent_at && <p className="field-help">Email delivered {formatDate(data.email_sent_at)}</p>}</section>}</>;
}
export default function ReportsPage() { const { userId } = useProfile(); return userId ? <Reports key={userId} userId={userId} /> : <><PageHeading eyebrow="A MOMENT TO REFLECT" title="Your weekly report." /><ProfileRequired /></>; }
