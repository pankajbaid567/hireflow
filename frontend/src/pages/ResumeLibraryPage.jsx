import { ArrowDownToLine, FileText } from 'lucide-react';
import { api, artifactUrl } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import { useRemote } from '../hooks/useRemote';
import { EmptyState, ErrorNotice, formatDate, Loading, PageHeading, ProfileRequired } from '../components/UI';
function Library({ userId }) {
  const { data, error, loading, reload } = useRemote(() => api.getResumes(userId), [userId]);
  const items = data?.items || [];
  return <><PageHeading eyebrow="BUILT AROUND YOUR STRENGTHS" title="Your resume library.">The right story for every opportunity. Find every version, ready when you are.</PageHeading>{loading && <Loading label="Opening your resume library…" />}{error && <ErrorNotice retry={reload}>{error}</ErrorNotice>}{!loading && !error && (items.length ? <div className="resume-grid">{items.map((item, index) => { const href = artifactUrl(item.download_url); return <article className="panel resume-card" key={`${item.application_id}-${item.version}-${index}`}><div className="resume-paper"><FileText size={33} strokeWidth={1.3} /><span>TAILORED FOR</span><strong>{item.company || item.company_name}</strong><div className="paper-lines"><i /><i /><i /><i /></div></div><div className="resume-card-details"><span className="pill">Version {item.version || 1}</span><h2>{item.role || item.role_title}</h2><p>{item.company || item.company_name} · {formatDate(item.generated_at)}</p>{href ? <a href={href} target="_blank" rel="noopener noreferrer" className="button button-secondary"><ArrowDownToLine size={16} />Download PDF</a> : <span className="muted">Download unavailable</span>}</div></article>; })}</div> : <EmptyState title="Your story, tailored to what’s next">Your generated resumes will live here as you build and review your weekly plan.</EmptyState>)}</>;
}
export default function ResumeLibraryPage() { const { userId } = useProfile(); return userId ? <Library key={userId} userId={userId} /> : <><PageHeading eyebrow="BUILT AROUND YOUR STRENGTHS" title="Your resume library." /><ProfileRequired /></>; }
