import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, ListFilter, RefreshCw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, errorMessage } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import { useRemote } from '../hooks/useRemote';
import JobCard from '../components/JobCard';
import ResumePreview from '../components/ResumePreview';
import { EmptyState, ErrorNotice, Loading, PageHeading, ProfileRequired } from '../components/UI';

function Plan({ userId, profile }) {
  const { data, setData, loading, error, reload } = useRemote(() => api.getPlan(userId), [userId]);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [preview, setPreview] = useState(null);
  const closePreview = useCallback(() => setPreview(null), []);
  useEffect(() => { if (data) setSelected((data.plan || []).map(job => job.job_id)); }, [data]);
  async function swap(remove, add) {
    setBusy(true); setActionError(''); setSuccess('');
    try { setData(await api.swapJob(userId, remove, add)); } catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setActionError(''); setSuccess('');
    try { const result = await api.confirmPlan(userId, selected); setSuccess(result.message || 'Your applications are confirmed. Follow their progress in the tracker.'); setData(current => ({ ...current, plan: current.plan.filter(job => !selected.includes(job.job_id)) })); }
    catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); }
  }
  const jobs = data?.plan || [];
  return <><PageHeading eyebrow="MAKE YOUR NEXT MOVE" title="Your weekly plan." action={<button className="button button-secondary button-small" onClick={reload} disabled={loading || busy}><RefreshCw size={15} />Refresh plan</button>}>A thoughtful shortlist, tailored to {profile?.name?.split(' ')[0] || 'you'}. Review each opportunity, then make it yours.</PageHeading>
    <div className="plan-banner"><span className="banner-icon"><Sparkles size={22} /></span><div><strong>A little focus. A lot of possibility.</strong><p>Review your resumes and choose the opportunities you’re ready to pursue.</p></div><span className="pill">{data?.quota || profile?.weekly_quota || '—'} per week</span></div>
    {loading && <Loading label="Preparing your weekly plan and resumes…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{actionError && <ErrorNotice>{actionError}</ErrorNotice>}{success && <div className="notice notice-success" role="status"><CheckCircle2 size={19} /><div>{success} <Link to="/applications">View applications <ArrowRight size={14} /></Link></div></div>}
    {!loading && !error && (jobs.length ? <><div className="list-heading"><h2>Your shortlist <span>{jobs.length}</span></h2><span><ListFilter size={14} />Ranked by your match score</span></div><div className="job-list">{jobs.map(job => <JobCard job={job} key={job.job_id} selected={selected.includes(job.job_id)} onSelect={() => setSelected(current => current.includes(job.job_id) ? current.filter(id => id !== job.job_id) : [...current, job.job_id])} alternatives={data.alternatives || []} onSwap={swap} onPreview={setPreview} busy={busy} />)}</div><div className="confirm-bar"><div><strong>{selected.length} {selected.length === 1 ? 'opportunity' : 'opportunities'} selected</strong><p>Confirming authorizes HireFlow to submit these applications.</p></div><button className="button" disabled={busy || !selected.length} onClick={confirm}><Check size={17} />{busy ? 'Working…' : 'Confirm and Apply'}</button></div></> : <EmptyState title={success ? 'Your next steps are in motion' : 'Your next opportunity is on its way'}>{success ? 'Track the progress of your confirmed applications, and come back for your next shortlist.' : 'No ranked listings are available yet. Run job discovery and matching for your profile, then refresh this plan.'}<Link className="button button-secondary" to="/applications">View applications <ArrowRight size={16} /></Link></EmptyState>)}
    {preview && <ResumePreview url={preview.resume_url} title={`${preview.company_name || preview.company} · Tailored resume`} onClose={closePreview} />}
  </>;
}
export default function WeeklyPlanPage() {
  const { userId, profile } = useProfile();
  return userId ? <Plan key={userId} userId={userId} profile={profile} /> : <><PageHeading eyebrow="MAKE YOUR NEXT MOVE" title="Your weekly plan." /><ProfileRequired /></>;
}
