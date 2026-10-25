import { ArrowLeft, ArrowUpRight, BookOpen, Building2, ChevronDown, Clock3, MessageSquare, Target } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, artifactUrl, externalUrl, errorMessage, isCloudflare } from '../api/client';
import { useRemote } from '../hooks/useRemote';
import TopicBadge from '../components/TopicBadge';
import { EmptyState, ErrorNotice, Loading, PageHeading } from '../components/UI';

const display = value => Array.isArray(value) ? value.map(display).join(', ') : typeof value === 'object' && value ? Object.values(value).map(display).join(' · ') : String(value ?? 'Not available');
function SafeLink({ url, children }) { const href = externalUrl(url); return href ? <a href={href} target="_blank" rel="noopener noreferrer">{children}<ArrowUpRight size={15} /></a> : <span>{children}</span>; }
const dateLabel = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString() : 'Date unknown';
function SourceEvidence({ evidence }) {
  if (!evidence) return null;
  const label = evidence.kind === 'job_context_estimate' ? 'Estimate from supplied listing context' : evidence.kind === 'accessible_search_excerpt' ? 'Accessible search excerpt; full-page claim unconfirmed' : evidence.kind === 'jd' ? 'From this JD' : evidence.kind === 'career_page' ? 'Reported on a career page' : 'Reported by an inspected public source';
  return <div className="question-hint"><p>{label}{evidence.url && <> · <SafeLink url={evidence.url}>Source</SafeLink></>}</p>{evidence.quote && <blockquote>{evidence.quote}</blockquote>}{evidence.note && <p>{evidence.note}</p>}</div>;
}
function CompanyEvidence({ intel }) {
  const claims = Object.entries(intel.claim_evidence || {}).flatMap(([field, rows]) => Array.isArray(rows) ? rows.map(row => ({ ...row, field })) : []);
  const seen = new Set(); const distinct = claims.filter(row => { const key = JSON.stringify([row.field, row.value, row.url, row.kind, row.quote]); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 15);
  const sources = Array.isArray(intel.sources) ? intel.sources : [];
  if (!distinct.length && !sources.length) return null;
  return <details><summary>Company sources and uncertainty</summary><p>Company facts below are attributed reports. Headcount may be approximate; candidate reports do not confirm the current interview process.</p>{distinct.map((evidence, index) => <div key={index}><strong>{evidence.field.replaceAll('_', ' ')}: {display(evidence.value)}</strong><SourceEvidence evidence={evidence} /></div>)}{sources.length > 0 && <ul>{sources.map((source, index) => <li key={index}><SafeLink url={source.url}>{source.title || 'Company source'}</SafeLink>{source.checked_at && <span> · checked {dateLabel(source.checked_at)}</span>}</li>)}</ul>}</details>;
}
function PrepExports({ applicationId, refreshKey }) {
  const [data, setData] = useState({ latest: null, versions: [] });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [metadataLoading, setMetadataLoading] = useState(true);
  useEffect(() => { let active = true; api.getPrepExports(applicationId).then(value => { if (active) setData(value); }).catch(reason => { if (active) setError(errorMessage(reason)); }).finally(() => { if (active) setMetadataLoading(false); }); return () => { active = false; }; }, [applicationId, refreshKey]);
  const latest = data.latest;
  useEffect(() => {
    if (!latest || !['queued', 'running'].includes(latest.state)) return;
    let active = true; const timer = setTimeout(() => api.getPrepExport(applicationId, latest.id).then(value => {
      if (active) { setError(''); setData(current => ({ latest: value, versions: [value, ...current.versions.filter(row => row.id !== value.id)] })); }
    }).catch(reason => { if (active) setError(errorMessage(reason)); }), 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [applicationId, latest]);
  async function create() {
    setBusy(true); setError('');
    try { const value = await api.startPrepExport(applicationId, { regenerate: Boolean(latest) }); setData(current => ({ latest: value, versions: [value, ...current.versions.filter(row => row.id !== value.id)] })); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function refresh() {
    setError(''); setBusy(true);
    try { if (latest && ['queued', 'running'].includes(latest.state)) { const value = await api.getPrepExport(applicationId, latest.id); setData(current => ({ latest: value, versions: [value, ...current.versions.filter(row => row.id !== value.id)] })); } else setData(await api.getPrepExports(applicationId)); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  const preparing = ['queued', 'running'].includes(latest?.state);
  const downloads = row => <span className="button-row">{row.html_url && <a className="button button-secondary button-small" href={artifactUrl(row.html_url)} target="_blank" rel="noopener noreferrer">Open HTML v{row.version}</a>}{row.pdf_url && <a className="button button-secondary button-small" href={artifactUrl(row.pdf_url)} target="_blank" rel="noopener noreferrer">Download PDF v{row.version}</a>}</span>;
  return <section className="panel guide-section" aria-label="Private guide exports"><h2>Take your prep with you</h2><p>Save the rounds, topics, resources, questions and company evidence as a private HTML or PDF snapshot. Each version retains its original content and expires after 30 days.</p>
    {error && <ErrorNotice retry={refresh}>{error}</ErrorNotice>}{preparing && <p className="notice notice-info" role="status">Preparing your private guide exports. This page checks for the completed files automatically.</p>}
    {latest?.state === 'ready' && <><p>Version {latest.version} · generated {new Date(latest.finished_at || latest.created_at).toLocaleString()}</p>{latest.stale && <p className="notice notice-info">Your guide or profile changed after this export. These downloads keep the original content. Review the current guide before creating a new version.</p>}{downloads(latest)}</>}
    {['failed', 'expired'].includes(latest?.state) && <p className="notice notice-info">{latest.failure_reason || 'This export is unavailable. Your saved guide is unchanged; create a new version.'}</p>}
    <button type="button" className="button button-secondary button-small" disabled={busy || preparing || metadataLoading} onClick={create}>{busy ? 'Creating…' : latest ? 'Create new export version' : 'Create private exports'}</button>
    {data.versions.length > 1 && <details><summary>Previous export versions</summary><ul>{data.versions.filter(row => row.id !== latest?.id).map(row => <li key={row.id}>Version {row.version} · {row.state}{row.stale ? ' · older snapshot' : ''}{row.state === 'ready' && downloads(row)}</li>)}</ul></details>}
  </section>;
}
export default function PrepGuidePage() {
  const { applicationId } = useParams();
  const { data, setData, loading, error, reload } = useRemote(() => api.getPrepGuide(applicationId), [applicationId]);
  const [refreshStatus, setRefreshStatus] = useState(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => { setRefreshStatus(null); setRefreshError(''); }, [applicationId]);
  useEffect(() => { if (data?.refresh) setRefreshStatus(data.refresh); }, [data?.refresh?.state, data?.refresh?.requested_at, applicationId]);
  const refreshing = ['queued', 'running'].includes(refreshStatus?.state);
  useEffect(() => {
    if (!refreshing) return;
    if (refreshStatus?.requested_at && Date.now() - Date.parse(refreshStatus.requested_at) > 7 * 60000) { setRefreshError('Stopped waiting for this refresh. Reload to check its status; your saved guide remains available.'); setRefreshStatus(current => ({ ...current, state: 'waiting_stopped' })); return; }
    let active = true;
    const timer = setTimeout(() => api.getPrepGuide(applicationId).then(fresh => { if (active) { setData(fresh); setRefreshStatus(fresh.refresh); } }).catch(reason => { if (active) { setRefreshError(errorMessage(reason)); setRefreshStatus(current => ({ ...current, checked_at: Date.now() })); } }), 2000);
    return () => { active = false; clearTimeout(timer); };
  }, [applicationId, refreshing, refreshStatus, setData]);
  async function refreshGuide() {
    setRefreshBusy(true); setRefreshError('');
    try { setRefreshStatus(await api.refreshPrepGuide(applicationId)); } catch (reason) { setRefreshError(errorMessage(reason)); } finally { setRefreshBusy(false); }
  }
  const guide = data?.structured_data || data || {};
  const rounds = Array.isArray(guide.rounds) ? guide.rounds : guide.rounds?.rounds || guide.round_prediction?.rounds || [];
  const topics = guide.topics || guide.topic_analysis || {};
  const resources = guide.resources || {};
  const questions = Array.isArray(guide.questions) ? guide.questions : guide.mock_questions || [];
  const intel = data?.company_intel || guide.company_intel || {};
  const news = Array.isArray(intel.recent_news) ? intel.recent_news : [];
  const patterns = Array.isArray(intel.interview_patterns) ? intel.interview_patterns : [];
  return <><Link to="/applications" className="back-link"><ArrowLeft size={15} />All applications</Link><PageHeading eyebrow="SHOW UP FEELING READY" title={data?.company ? `Prepare for ${data.company}.` : 'Your interview prep guide.'}>{data?.role || 'A focused starting point for your next conversation.'}</PageHeading>{loading && <Loading label="Opening your prep guide…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{!loading && !error && data && <><div className="guide-intro"><BookOpen size={23} /><div><strong>A little preparation goes a long way.</strong><p>Start with your skill gaps, explore a resource, then practise a few questions out loud. Interview rounds are predictions and may vary.</p></div></div>{(guide.warnings || []).map((warning, i) => <p className="notice notice-info" key={i}>{display(warning)}</p>)}
    {isCloudflare() && typeof api.refreshPrepGuide === 'function' && <section className="panel guide-section" aria-label="Refresh interview preparation"><h2>Keep your preparation current</h2>{data.guide_stale && <p className="notice notice-info">This saved guide uses an older profile or listing. Refresh it to prepare from your current context.</p>}{refreshError && <ErrorNotice retry={reload}>{refreshError}</ErrorNotice>}{refreshing && <p role="status">Refreshing your preparation in the background. Your saved guide remains available below.</p>}{refreshStatus?.state === 'failed' && <p className="notice notice-info">{refreshStatus.failure_reason || 'Refresh could not finish. Your saved guide is unchanged.'}</p>}{refreshStatus?.state === 'completed' && <p role="status">Preparation refreshed. Previous export downloads keep their original content.</p>}<button type="button" className="button button-secondary button-small" disabled={refreshBusy || refreshing} onClick={refreshGuide}>{refreshBusy ? 'Requesting refresh…' : 'Refresh preparation'}</button></section>}
    {isCloudflare() && typeof api.getPrepExports === 'function' && <PrepExports key={applicationId} applicationId={applicationId} refreshKey={data.guide_revision || guide.generated_at} />}
    <div className="guide-layout"><div className="guide-main"><section id="rounds" className="panel guide-section"><div className="section-heading"><span className="section-icon"><Clock3 size={20} /></span><div><h2>The conversation ahead</h2><p>Likely interview rounds and what to expect.</p></div></div>{rounds.length ? <ol className="round-list">{rounds.map((round, i) => <li key={i}><span className="round-number">{round.number || i + 1}</span><div><span className="eyebrow">ROUND {round.number || i + 1}</span><h3>{round.type || round.title}</h3><p>{display(round.focus || round.focus_areas || round.description)}</p>{typeof round.estimated === 'boolean' && <p className="muted">{round.estimated ? 'Estimated stage — confirm with the recruiter.' : 'Source-reported stage — the current process may change.'}</p>}{round.evidence && <details><summary>Stage evidence</summary><SourceEvidence evidence={round.evidence} /></details>}</div></li>)}</ol> : <p className="muted">The company hasn’t shared enough information to predict its process. Ask your recruiter about the next steps.</p>}</section>
    <section id="topics" className="panel guide-section"><div className="section-heading"><span className="section-icon"><Target size={20} /></span><div><h2>Your study compass</h2><p>Put your time where it makes the most difference.</p></div></div><div className="topic-groups">{[['strong', 'Build on your strengths', 'Skills already in your profile.'], ['moderate', 'Brush up a little', 'Related experience to connect and practise.'], ['gaps', 'Make room to learn', 'New skills to focus on before the interview.']].map(([key, title, description]) => <div key={key}><h3><span className={`legend-dot topic-${key === 'gaps' ? 'gap' : key}`} />{title}</h3><p>{description}</p><div className="topic-row">{(topics[key] || (key === 'gaps' ? topics.gap : []) || []).map((topic, i) => <TopicBadge key={i} topic={topic} level={key === 'gaps' ? 'gap' : key} />)}{!(topics[key] || (key === 'gaps' ? topics.gap : []) || []).length && <span className="muted">No topics in this group.</span>}</div></div>)}</div>{Array.isArray(guide.topic_evidence) && guide.topic_evidence.length > 0 && <details><summary>How your topics were grouped</summary><ul>{guide.topic_evidence.map((topic, index) => <li key={index}><strong>{topic.topic}</strong>: {topic.explanation}{Array.isArray(topic.related_skills) && topic.related_skills.length > 0 && <span> Related skills: {topic.related_skills.join(', ')}.</span>}</li>)}</ul></details>}</section>
    <section id="resources" className="panel guide-section"><div className="section-heading"><span className="section-icon"><BookOpen size={20} /></span><div><h2>A good place to start</h2><p>Documentation and learning materials, topic by topic.</p></div></div>{Object.keys(resources).length ? <div className="resource-groups">{Object.entries(resources).map(([topic, links]) => <div key={topic}><h3>{topic}</h3>{Array.isArray(links) && links.length ? <ul>{links.map((link, i) => <li key={i}><SafeLink url={link.url}>{link.title || link.url}</SafeLink>{link.description && <p>{link.description}</p>}{link.checked_at && <p className="muted">Link checked {dateLabel(link.checked_at)}. Topic match is based on its title and description.</p>}</li>)}</ul> : <p className="muted">No accessible resources found yet.</p>}</div>)}</div> : <p className="muted">No resources are available for this guide yet.</p>}</section>
    <section id="questions" className="panel guide-section"><div className="section-heading"><span className="section-icon"><MessageSquare size={20} /></span><div><h2>Practise the conversation</h2><p>Open one question at a time. Give yourself space to think.</p></div></div>{questions.length ? <div className="questions">{questions.map((question, i) => <details key={i}><summary><span className="question-label"><span className="question-number">{String(i + 1).padStart(2, '0')}</span><span>{question.category || 'Practice'} question</span></span><ChevronDown size={18} /></summary><div className="question-body"><p>{question.question || question.text}</p>{question.hint && <p className="question-hint">Think about: {question.hint}</p>}{question.focus && <p className="muted">Practise: {question.focus}</p>}<SourceEvidence evidence={question.evidence} /></div></details>)}</div> : <p className="muted">Mock questions haven’t been generated yet.</p>}</section></div>
    <aside className="guide-aside"><nav className="panel guide-nav" aria-label="Prep guide sections"><span className="eyebrow">YOUR PREP PATH</span><a href="#rounds">01 <span>Interview rounds</span></a><a href="#topics">02 <span>Study topics</span></a><a href="#resources">03 <span>Learning resources</span></a><a href="#questions">04 <span>Practice questions</span></a></nav><section className="panel company-intel"><div className="section-heading"><Building2 size={20} /><h2>Know the company</h2></div><dl><div><dt>Stage</dt><dd>{display(intel.stage)}</dd></div><div><dt>Estimated team size</dt><dd>{display(intel.team_size || intel.estimated_team_size)}</dd></div><div><dt>Tech stack</dt><dd>{display(intel.tech_stack)}</dd></div></dl><CompanyEvidence intel={intel} /><h3>Recent news</h3>{news.length ? <ul className="intel-list">{news.map((item, i) => <li key={i}>{typeof item === 'string' ? item : <><SafeLink url={item.url}>{item.title || item.summary}</SafeLink><p className="muted">Published {dateLabel(item.published_at)}</p></>}</li>)}</ul> : <p className="muted">No recent news found.</p>}<h3>Candidate experiences</h3>{patterns.length ? <ul className="intel-list">{patterns.map((pattern, i) => <li key={i}>{typeof pattern === 'string' ? pattern : <><SafeLink url={pattern.url}>{pattern.summary || pattern.pattern || pattern.title || display(pattern)}</SafeLink><p className="muted">{pattern.date_status === 'historical' ? 'Historical report' : pattern.date_status === 'within_90_days' ? 'Dated candidate report' : 'Date unknown'}{pattern.published_at ? ` · ${dateLabel(pattern.published_at)}` : ''}. Current interview stages are unconfirmed.</p>{pattern.note && <p>{pattern.note}</p>}</>}</li>)}</ul> : <p className="muted">{intel.interview_review_status || intel.fallback_guidance || 'No interview reviews found. Ask your recruiter what to expect and practise the questions in this guide.'}</p>}</section></aside></div>{guide.content && <section className="panel guide-section"><h2>Additional notes</h2><p className="preserve-lines">{guide.content}</p></section>}</>}{!loading && !error && !data && <EmptyState title="Your prep guide is taking shape">Come back after your resume and interview preparation have been generated.</EmptyState>}</>;
}
