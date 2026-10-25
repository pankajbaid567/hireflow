import DiscoveryCyclePanel from '../components/DiscoveryCyclePanel';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Check, CheckCircle2, ListFilter, RefreshCw, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api, errorMessage, isCloudflare } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import { useRemote } from '../hooks/useRemote';
import JobCard from '../components/JobCard';
import ResumePreview from '../components/ResumePreview';
import OpportunityDiscovery from '../components/OpportunityDiscovery';
import ApplicationReview from '../components/ApplicationReview';
import OperationsStatus from '../components/OperationsStatus';
import { EmptyState, ErrorNotice, Loading, PageHeading, ProfileRequired } from '../components/UI';

function Plan({ userId, profile }) {
  const { activateProfile } = useProfile();
  const { data, setData, loading, error, reload } = useRemote(() => api.getPlan(userId), [userId]);
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [success, setSuccess] = useState('');
  const [preview, setPreview] = useState(null);
  const [reviewJob,setReviewJob]=useState(null);
  const closePreview = useCallback(() => setPreview(null), []);
  const closeReview = useCallback(() => setReviewJob(null), []);
  const reviewRequired=data?.review_required===true;
  const individual = (data?.confirmation_mode || profile?.confirmation_mode || profile?.master_profile?.confirmation_mode) === 'individual';
  useEffect(() => { if (data) { const ids = (data.plan || []).map(job => job.job_id); setSelected(individual ? ids.slice(0, 1) : ids); } }, [data, individual]);
  useEffect(() => {
    if (!isCloudflare() || !data?.preparing || busy || loading) return;
    const timer = setTimeout(reload, 2000);
    return () => clearTimeout(timer);
  }, [data?.preparing, busy, loading, reload]);
  async function refresh() {
    if (!isCloudflare() || typeof api.refreshMatching !== 'function') return reload();
    setBusy(true); setActionError('');
    try { setData(await api.refreshMatching(userId)); } catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function swap(remove, add) {
    setBusy(true); setActionError(''); setSuccess('');
    try { setData(await api.swapJob(userId, remove, add)); } catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setActionError(''); setSuccess('');
    try { const ids = individual ? selected.slice(0, 1) : selected;
      const result = reviewRequired ? await api.confirmPlan(userId,ids,ids.map(id=>data.plan.find(job=>job.job_id===id)?.review_id)) : await api.confirmPlan(userId, ids);
      setSuccess(result.message || 'Your applications are confirmed. Follow their progress in the tracker.'); setData(current => ({ ...current, plan: current.plan.filter(job => !ids.includes(job.job_id)) })); }
    catch (error) { setActionError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function excludeCompany(job) {
    const company = String(job.company_name || job.company || '').trim();
    if (!company) return;
    setBusy(true); setActionError(''); setSuccess('');
    try {
      const existing = profile?.master_profile?.blacklist_companies || [];
      const excluded = Array.isArray(existing) ? [...existing] : [existing];
      if (!excluded.some(name => String(name).toLowerCase() === company.toLowerCase())) excluded.push(company);
      const saved = await api.saveProfile({ blacklist_companies: excluded }, userId);
      activateProfile(saved);
      setData(await api.getPlan(userId));
      setSuccess(`${company} is excluded from future weekly plans. You can change this in your profile.`);
    } catch (error) { setActionError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const jobs = data?.plan || [];
  const reviewed=selected.every(id=>jobs.some(job=>job.job_id===id&&job.review_id&&!job.resume_rejected));
  return <><PageHeading eyebrow="MAKE YOUR NEXT MOVE" title="Your weekly plan." action={<button className="button button-secondary button-small" onClick={refresh} disabled={loading || busy}><RefreshCw size={15} />Refresh plan</button>}>A thoughtful shortlist, tailored to {profile?.name?.split(' ')[0] || 'you'}. Review each opportunity, then make it yours.</PageHeading>
    {isCloudflare() && <OpportunityDiscovery userId={userId} profile={profile} onUpdated={reload} />}
    {isCloudflare() && typeof api.getDiscoveryCycle==='function' && <DiscoveryCyclePanel userId={userId} onUpdated={reload}/>}
    {isCloudflare() && <OperationsStatus userId={userId} loadStatus={api.getOperations} runDiagnostics={api.runModelDiagnostics}/>}
    <div className="plan-banner"><span className="banner-icon"><Sparkles size={22} /></span><div><strong>A little focus. A lot of possibility.</strong><p>Review your resumes and choose the opportunities you’re ready to pursue.</p></div><span className="pill">{data?.quota || profile?.weekly_quota || '—'} per week</span></div>
    {isCloudflare() && (data?.warnings || []).map((warning, index) => <div className="notice notice-info" role="status" key={index}>{warning}</div>)}
    {loading && <Loading label="Preparing your weekly plan and resumes…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{actionError && <ErrorNotice>{actionError}</ErrorNotice>}{success && <div className="notice notice-success" role="status"><CheckCircle2 size={19} /><div>{success} <Link to="/applications">View applications <ArrowRight size={14} /></Link></div></div>}
    {!loading && !error && (jobs.length ? <><div className="list-heading"><h2>Your shortlist <span>{jobs.length}</span></h2><span><ListFilter size={14} />Ranked by your match score</span></div><div className="job-list">{jobs.map(job => <JobCard job={job} key={job.job_id} selected={selected.includes(job.job_id)} onSelect={() => setSelected(current => current.includes(job.job_id) ? current.filter(id => id !== job.job_id) : individual ? [job.job_id] : [...current, job.job_id])} alternatives={data.alternatives || []} onSwap={swap} onExclude={excludeCompany} onPreview={setPreview} onReview={reviewRequired?setReviewJob:undefined} busy={busy} />)}</div><div className="confirm-bar"><div><strong>{selected.length} {selected.length === 1 ? 'opportunity' : 'opportunities'} selected</strong><p>{reviewRequired&&!reviewed?'Approve each selected PDF and its answers before confirming.':individual ? 'Choose and authorize one opportunity at a time.' : 'Confirming authorizes HireFlow to submit these applications.'}</p></div><button className="button" disabled={busy || !selected.length || (reviewRequired&&!reviewed) || (isCloudflare() && data?.preparing)} onClick={confirm}><Check size={17} />{busy ? 'Working…' : individual ? 'Confirm this opportunity' : 'Confirm and Apply'}</button></div></> : data?.preparing && isCloudflare() ? <Loading label="Preparing your matches and resumes. Your plan will update automatically…" /> : <EmptyState title={success ? 'Your shortlist is up to date' : 'Your next opportunity is on its way'}>{success ? 'Review your profile preferences or find new opportunities for your next shortlist.' : 'No ranked listings are available yet. Add an opportunity or find new listings, then refresh this plan.'}<Link className="button button-secondary" to="/applications">View applications <ArrowRight size={16} /></Link></EmptyState>)}
    {preview && <ResumePreview url={preview.resume_url} title={`${preview.company_name || preview.company} · Tailored resume`} onClose={closePreview} />}
    {reviewJob && <ApplicationReview job={reviewJob} onClose={closeReview} onUpdated={reload}/>}
  </>;
}
export default function WeeklyPlanPage() {
  const { userId, profile } = useProfile();
  return userId ? <Plan key={userId} userId={userId} profile={profile} /> : <><PageHeading eyebrow="MAKE YOUR NEXT MOVE" title="Your weekly plan." /><ProfileRequired /></>;
}
