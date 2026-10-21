import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, FileUp, Save, UserRound } from 'lucide-react';
import { api, errorMessage } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import ModeSelector from '../components/ModeSelector';
import { ErrorNotice, Loading, PageHeading } from '../components/UI';

const blank = { name: '', email: '', phone: '', skills: '', mode: 'internship', weekly_quota: 10, target_roles: '', preferred_locations: '', education: '', experience_years: 0 };
const split = value => value.split(',').map(item => item.trim()).filter(Boolean);
export default function ProfilePage() {
  const { profile, userId, loading, error: profileError, activateProfile, selectProfile, clearProfile } = useProfile();
  const [form, setForm] = useState(blank);
  const [resume, setResume] = useState(null);
  const [existingId, setExistingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploadKey, setUploadKey] = useState(0);
  useEffect(() => {
    const source = profile?.master_profile || {};
    setForm(profile ? { ...blank, ...source, name: profile.name, email: profile.email, mode: profile.mode, weekly_quota: profile.weekly_quota, skills: (source.skills || []).join(', '), target_roles: (source.target_roles || []).join(', '), preferred_locations: (source.preferred_locations || []).join(', '), education: typeof source.education === 'string' ? source.education : JSON.stringify(source.education || '') } : blank);
  }, [profile]);
  const update = event => setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  async function submit(event) {
    event.preventDefault(); setError(''); setSuccess('');
    if (resume && !resume.name.toLowerCase().endsWith('.pdf')) { setError('Choose a PDF resume.'); return; }
    if (resume?.size > 10 * 1024 * 1024) { setError('Choose a PDF smaller than 10 MB.'); return; }
    const data = { ...form, skills: split(form.skills), target_roles: split(form.target_roles), preferred_locations: split(form.preferred_locations), weekly_quota: Number(form.weekly_quota), experience_years: Number(form.experience_years) };
    let payload = data;
    if (resume) {
      payload = new FormData();
      Object.entries(data).forEach(([key, value]) => payload.append(key, Array.isArray(value) ? JSON.stringify(value) : value));
      payload.append('resume', resume);
    }
    setBusy(true);
    try { const saved = await api.saveProfile(payload, profile?.id); activateProfile(saved); setSuccess(`Profile saved. Your profile ID is ${saved.id}.`); setResume(null); setUploadKey(key => key + 1); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function openProfile(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try { await selectProfile(existingId); setSuccess('Profile opened.'); } catch (error) { setError(errorMessage(error)); }
  }
  return <><PageHeading eyebrow="YOUR FOUNDATION" title="A profile that feels like you.">Tell us where you want to go. We’ll help you find the way.</PageHeading>
    {loading && <Loading label="Opening your profile…" />}{(error || profileError) && <ErrorNotice>{error || profileError}</ErrorNotice>}{success && <div className="notice notice-success" role="status"><CheckCircle2 size={19} />{success}</div>}
    <div className="profile-layout"><form className="panel profile-form" onSubmit={submit}><div className="section-heading"><span className="section-icon"><UserRound size={20} /></span><div><h2>{profile ? 'Your profile' : 'Let’s get acquainted'}</h2><p>A few details make every match more personal.</p></div>{profile && <span className="pill">ID {userId}</span>}</div>
      <div className="form-grid"><label>Full name<input name="name" value={form.name} onChange={update} placeholder="e.g. Alex Morgan" autoComplete="name" required maxLength={200} /></label><label>Email address<input name="email" type="email" value={form.email} onChange={update} placeholder="you@example.com" autoComplete="email" required /></label><label>Phone number<input name="phone" type="tel" value={form.phone || ''} onChange={update} placeholder="Include your country code" autoComplete="tel" /></label><label>Years of experience<input name="experience_years" type="number" min="0" max="80" step="0.5" value={form.experience_years ?? 0} onChange={update} /></label><label className="full-width">Skills<input name="skills" value={form.skills} onChange={update} placeholder="Python, React, SQL, problem solving" /><span className="field-help">Separate skills with commas. Include the things you enjoy working with.</span></label><label className="full-width">Education<input name="education" value={form.education || ''} onChange={update} placeholder="Degree, university, graduation year" /></label></div>
      <div className="form-divider" /><h3>What are you looking for?</h3><ModeSelector value={form.mode} onChange={mode => setForm(current => ({ ...current, mode }))} />
      <div className="form-grid"><label>Target roles<input name="target_roles" value={form.target_roles} onChange={update} placeholder="AI Engineer, Software Developer" /></label><label>Preferred locations<input name="preferred_locations" value={form.preferred_locations} onChange={update} placeholder="Bengaluru, Remote" /></label><label>Applications per week<input name="weekly_quota" type="number" min="1" max="100" value={form.weekly_quota} onChange={update} required /><span className="field-help">Set a pace you can prepare for. Between 1 and 100.</span></label></div>
      <div className="form-divider" /><h3>Your starting resume</h3><label className="upload-area"><FileUp size={27} aria-hidden="true" /><strong>{resume ? resume.name : 'Add your resume'}</strong><span>Choose a PDF · up to 10 MB</span><input key={uploadKey} aria-label="Resume PDF" type="file" accept=".pdf,application/pdf" onChange={event => { setResume(event.target.files?.[0] || null); setError(''); }} /></label>{profile?.master_profile?.master_resume_path && <p className="field-help">A resume is already saved. Upload a new PDF to replace it.</p>}
      <footer className="form-footer"><p>You’ll review your plan before applications are submitted.</p><button className="button" disabled={busy || loading} type="submit"><Save size={17} />{busy ? 'Saving…' : 'Save profile'}</button></footer>
    </form><aside className="profile-aside"><div className="gentle-card"><span className="eyebrow">A LITTLE INTENTION GOES FAR</span><h2>Better matches.<br />More meaningful moves.</h2><p>Your skills and preferences shape every opportunity, every resume, and every prep guide.</p><ol><li><span>01</span>Build your profile</li><li><span>02</span>Review your weekly plan</li><li><span>03</span>Apply with confidence</li></ol></div><form className="panel small-panel" onSubmit={openProfile}><h3>Already have a profile?</h3><p>Open it with the profile ID from your last visit.</p><label>Profile ID<input type="number" min="1" value={existingId} onChange={event => setExistingId(event.target.value)} required placeholder="e.g. 1" /></label><button type="submit" className="button button-secondary" disabled={loading}>Open profile <ArrowRight size={16} /></button>{profile && <button type="button" className="text-button" onClick={() => { clearProfile(); setSuccess(''); setResume(null); }}>Create a different profile</button>}</form></aside></div>
  </>;
}
