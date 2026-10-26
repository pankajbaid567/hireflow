import { useState } from 'react';
import { ArrowUpRight, BookOpen, CalendarDays, ChevronRight, Files, Menu, MoveUpRight, Settings2, Sprout, UserRound, UsersRound, X } from 'lucide-react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useProfile } from './context/ProfileContext';
import ProfilePage from './pages/ProfilePage';
import WeeklyPlanPage from './pages/WeeklyPlanPage';
import ApplicationTrackerPage from './pages/ApplicationTrackerPage';
import PrepGuidePage from './pages/PrepGuidePage';
import ResumeLibraryPage from './pages/ResumeLibraryPage';
import ReportsPage from './pages/ReportsPage';
import HiringPage from './pages/HiringPage';
import { EmptyState } from './components/UI';

const navigation = [
  ['/weekly-plan', CalendarDays, 'Weekly plan'],
  ['/applications', MoveUpRight, 'Applications'],
  ['/resumes', Files, 'Resume library'],
  ['/reports', BookOpen, 'Weekly report'],
  ['/hiring', UsersRound, 'Hiring shortlist'],
];
export default function App() {
  const { profile, userId } = useProfile();
  const [menuOpen, setMenuOpen] = useState(false);
  return <div className="app-shell"><a href="#main-content" className="skip-link">Skip to content</a><aside className={`sidebar ${menuOpen ? 'mobile-open' : ''}`}><Link to="/weekly-plan" className="brand" onClick={() => setMenuOpen(false)}><span className="brand-icon"><Sprout size={24} /></span>hireflow<span className="brand-period">.</span></Link><button className="mobile-close icon-button" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><X /></button><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(([path, Icon, label]) => <NavLink key={path} to={path} onClick={() => setMenuOpen(false)}><Icon size={19} /><span>{label}</span><ChevronRight className="nav-chevron" size={14} /></NavLink>)}</nav><div className="sidebar-note"><span className="small-leaf"><Sprout size={24} /></span><strong>Small steps.<br />Real progress.</strong><p>Your next chapter starts with one thoughtful move.</p></div><div className="sidebar-bottom"><NavLink to="/profile" onClick={() => setMenuOpen(false)}><Settings2 size={19} />Profile & preferences</NavLink><div className="profile-summary"><span className="avatar">{profile?.name?.slice(0, 1).toUpperCase() || <UserRound size={18} />}</span><div><strong>{profile?.name || 'Your workspace'}</strong><span>{userId ? `Profile ${userId} · ${profile?.mode || 'Loading'}` : 'Let’s get you started'}</span></div></div></div></aside>{menuOpen && <button className="mobile-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}
    <div className="main-shell"><div className="topbar"><div className="breadcrumb"><button className="mobile-menu icon-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation"><Menu size={22} /></button><span>Workspace</span><ChevronRight size={13} /><strong>My career</strong></div><div className="topbar-right"><span className="workspace-status"><span />A little closer to what’s next</span><Link to="/profile" className="topbar-avatar" aria-label="Your profile">{profile?.name?.slice(0, 1).toUpperCase() || <UserRound size={17} />}</Link></div></div><main id="main-content" tabIndex="-1"><Routes><Route path="/" element={<Navigate to={userId ? '/weekly-plan' : '/profile'} replace />} /><Route path="/profile" element={<ProfilePage />} /><Route path="/weekly-plan" element={<WeeklyPlanPage />} /><Route path="/applications" element={<ApplicationTrackerPage />} /><Route path="/applications/:applicationId/prep-guide" element={<PrepGuidePage />} /><Route path="/resumes" element={<ResumeLibraryPage />} /><Route path="/reports" element={<ReportsPage />} /><Route path="/hiring" element={<div className="hiring-page"><HiringPage /></div>} /><Route path="*" element={<EmptyState title="A small detour">This page isn’t here. Let’s get you back to your workspace.<Link className="button" to="/weekly-plan">Back to weekly plan <ArrowUpRight size={16} /></Link></EmptyState>} /></Routes></main><footer className="app-footer"><span>Made for your next chapter.</span><span>HireFlow <span className="footer-dot">·</span> Intentional applications. Meaningful opportunities.</span></footer></div></div>;
}
