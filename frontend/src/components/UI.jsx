import { AlertCircle, ArrowUpRight, RefreshCw, Sprout } from 'lucide-react';
import { Link } from 'react-router-dom';

export function PageHeading({ eyebrow, title, children, action }) {
  return <header className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1>{children && <p className="page-description">{children}</p>}</div>{action && <div className="heading-action">{action}</div>}</header>;
}
export function ErrorNotice({ children, retry }) {
  return <div className="notice notice-error" role="alert"><AlertCircle size={19} aria-hidden="true" /><div>{children}</div>{retry && <button className="text-button" onClick={retry}>Try again</button>}</div>;
}
export function Loading({ label = 'Loading your workspace…' }) {
  return <div className="loading" role="status"><RefreshCw className="spin" size={22} />{label}</div>;
}
export function EmptyState({ title, children, action }) {
  return <div className="empty-state"><span className="empty-icon"><Sprout size={30} /></span><h2>{title}</h2><p>{children}</p>{action}</div>;
}
export function ProfileRequired() {
  return <EmptyState title="Start with a little about you">Create a profile or open an existing one to see your opportunities.<Link to="/profile" className="button">Set up profile <ArrowUpRight size={17} /></Link></EmptyState>;
}
export function StatusBadge({ status }) {
  const label = String(status || 'pending').replaceAll('_', ' ');
  return <span className={`status-badge status-${status || 'pending'}`}><span />{label}</span>;
}
export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
export function scorePercent(value) {
  if (value === null || value === undefined) return '—';
  const score = Number(value);
  if (!Number.isFinite(score)) return '—';
  return `${Math.round(score <= 1 ? score * 100 : score)}%`;
}
