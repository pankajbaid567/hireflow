import { Building2, ChevronDown, ExternalLink, FileText, MapPin } from 'lucide-react';
import TopicBadge from './TopicBadge';
import ListingFacts from './ListingFacts';
import { scorePercent } from './UI';
import { externalUrl } from '../api/client';

function publicListingUrl(value) {
  const href = externalUrl(value);
  if (!href) return null;
  const url = new URL(href), host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.username || url.password || !host.includes('.') || host.includes(':') || /(?:^|\.)(localhost|local|internal)$/.test(host) || host === 'metadata.google.internal' || host.endsWith('.home.arpa')) return null;
  if (/^[\d.]+$/.test(host)) {
    const parts = host.split('.').map(Number), [a, b] = parts;
    if (parts.length !== 4 || parts.some(part => part > 255) || a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return null;
  }
  return href;
}

export default function JobCard({ job, alternatives = [], selected, onSelect, onPreview, onSwap, onExclude, onReview, busy }) {
  const gaps = Array.isArray(job.skill_gaps) ? job.skill_gaps : [];
  const listingUrl = publicListingUrl(job.url);
  return <article className={`job-card ${!selected ? 'unselected' : ''}`}>
    <div className="job-card-main"><div className="company-mark" aria-hidden="true">{(job.company_name || job.company || '?').slice(0, 1).toUpperCase()}</div><div className="job-details"><p className="company-label"><Building2 size={13} />{job.company_name || job.company || 'Company'}</p><h2>{job.role_title || job.role}</h2><div className="job-meta">{job.location && <span><MapPin size={13} />{job.location}</span>}<span>{({ internship: 'Internship', job: 'Job' })[job.listing_type] || 'Opportunity'}</span>{typeof job.source === 'string' && job.source && <span>{job.source}</span>}</div></div><div className="match-score"><strong>{scorePercent(job.match_score)}</strong><span>match score</span></div><label className="select-job"><input type="checkbox" checked={selected} onChange={onSelect} disabled={busy} aria-label={`Include ${job.role_title || job.role}`} /></label></div>
    <ListingFacts job={job} />
    {job.resume_url && job.resume_tailoring && job.resume_summary && <details className="resume-focus"><summary>Resume focus <span>{job.resume_tailoring.method === 'llm_grounded' ? 'AI-selected facts' : 'Matched profile facts'}</span></summary><p>{job.resume_summary}</p></details>}
    {onReview && <div className="job-review-state"><span>{job.resume_rejected?'Resume rejected':job.review_id?'PDF and answers approved':'PDF and answers need review'}</span><button type="button" className="button button-secondary button-small" aria-label={`Review ${job.role_title||job.role}`} disabled={busy||!job.resume_url} onClick={()=>onReview(job)}>Review resume &amp; answers</button></div>}
    <div className="job-card-bottom"><div className="gap-list">{gaps.length ? <><span className="muted">Build confidence in</span>{gaps.slice(0, 4).map((gap, i) => <TopicBadge key={i} topic={gap} level="gap" />)}</> : <span className="good-fit">Your skills are a strong fit</span>}</div><div className="job-actions">{listingUrl && <a className="text-button" href={listingUrl} target="_blank" rel="noopener noreferrer">View listing <ExternalLink size={13} /></a>}<button type="button" className="text-button" disabled={!job.resume_url || busy} onClick={() => onPreview(job)}><FileText size={15} />{job.resume_url ? 'Preview resume' : 'Resume pending'}</button><div className="swap-select"><select aria-label={`Swap ${job.role_title || job.role}`} value="" disabled={!alternatives.length || busy} onChange={event => { if (event.target.value) onSwap(job.job_id, Number(event.target.value)); }}><option value="">Swap listing</option>{alternatives.map(alt => <option value={alt.job_id} key={alt.job_id}>{alt.company_name || alt.company} · {alt.role_title || alt.role}</option>)}</select><ChevronDown size={14} /></div>{onExclude && <button type="button" className="text-button" disabled={busy} onClick={() => onExclude(job)} aria-label={`Exclude ${job.company_name || job.company} from future plans`}>Exclude company</button>}</div></div>
  </article>;
}
