import { Building2, ChevronDown, FileText, MapPin } from 'lucide-react';
import TopicBadge from './TopicBadge';
import { scorePercent } from './UI';

export default function JobCard({ job, alternatives = [], selected, onSelect, onPreview, onSwap, busy }) {
  const gaps = Array.isArray(job.skill_gaps) ? job.skill_gaps : [];
  return <article className={`job-card ${!selected ? 'unselected' : ''}`}>
    <div className="job-card-main"><div className="company-mark" aria-hidden="true">{(job.company_name || job.company || '?').slice(0, 1).toUpperCase()}</div><div className="job-details"><p className="company-label"><Building2 size={13} />{job.company_name || job.company || 'Company'}</p><h2>{job.role_title || job.role}</h2><div className="job-meta">{job.location && <span><MapPin size={13} />{job.location}</span>}<span>{job.listing_type || 'Opportunity'}</span></div></div><div className="match-score"><strong>{scorePercent(job.match_score)}</strong><span>match score</span></div><label className="select-job"><input type="checkbox" checked={selected} onChange={onSelect} disabled={busy} aria-label={`Include ${job.role_title || job.role}`} /></label></div>
    <div className="job-card-bottom"><div className="gap-list">{gaps.length ? <><span className="muted">Build confidence in</span>{gaps.slice(0, 4).map((gap, i) => <TopicBadge key={i} topic={gap} level="gap" />)}</> : <span className="good-fit">Your skills are a strong fit</span>}</div><div className="job-actions"><button type="button" className="text-button" disabled={!job.resume_url || busy} onClick={() => onPreview(job)}><FileText size={15} />{job.resume_url ? 'Preview resume' : 'Resume pending'}</button><div className="swap-select"><select aria-label={`Swap ${job.role_title || job.role}`} value="" disabled={!alternatives.length || busy} onChange={event => { if (event.target.value) onSwap(job.job_id, Number(event.target.value)); }}><option value="">Swap listing</option>{alternatives.map(alt => <option value={alt.job_id} key={alt.job_id}>{alt.company_name || alt.company} · {alt.role_title || alt.role}</option>)}</select><ChevronDown size={14} /></div></div></div>
  </article>;
}
