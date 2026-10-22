import { useEffect, useState } from 'react';
import { ArrowRight, CheckCircle2, FileUp, Save, UserRound } from 'lucide-react';
import { api, errorMessage, isCloudflare } from '../api/client';
import { useProfile } from '../context/ProfileContext';
import ModeSelector from '../components/ModeSelector';
import ProfileDetailsEditor from '../components/ProfileDetailsEditor';
import { ErrorNotice, Loading, PageHeading } from '../components/UI';

const blank = { name: '', email: '', phone: '', skills: '', mode: 'internship', weekly_quota: 10, target_roles: '', preferred_locations: '', education: '', experience_years: '', min_stipend: '', min_salary: '', blacklist_companies: '', confirmation_mode: 'batch', summary: '', experience: [], projects: [], links: [], certifications: [], achievements: [], languages: [] };
const split = value => value.split(',').map(item => item.trim()).filter(Boolean);
const lines = value => typeof value === 'string' ? value.split('\n').map(item => item.trim()).filter(Boolean) : value || [];
const commaList = value => typeof value === 'string' ? split(value) : value || [];
const nonempty = item => typeof item === 'string' ? Boolean(item.trim()) : Object.values(item || {}).some(value => Array.isArray(value) ? value.length > 0 : Boolean(String(value || '').trim()));
function validLink(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function previousWorkspace() {
  try { const url = new URL(import.meta.env.VITE_PREVIOUS_DASHBOARD_URL); return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? `${url.origin}/api/workspace-migrate` : null; } catch { return null; }
}
function educationText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(educationText).filter(Boolean).join('; ');
  if (typeof value === 'object') {
    const fields = ['degree', 'institution', 'year'];
    return [...fields, ...Object.keys(value).filter(key => !fields.includes(key))].map(key => educationText(value[key])).filter(Boolean).join(', ');
  }
  return String(value);
}
export default function ProfilePage() {
  const { profile, userId, loading, error: profileError, activateProfile, selectProfile, clearProfile, logoutProfile } = useProfile();
  const cloud = isCloudflare();
  const [form, setForm] = useState(blank);
  const [resume, setResume] = useState(null);
  const [existingId, setExistingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [uploadKey, setUploadKey] = useState(0);
  const [educationEdited, setEducationEdited] = useState(false);
  useEffect(() => {
    const source = profile?.master_profile || {};
    setForm(profile ? { ...blank, ...source, name: profile.name, email: profile.email, mode: profile.mode, weekly_quota: profile.weekly_quota, confirmation_mode: profile.confirmation_mode || source.confirmation_mode || 'batch', skills: (source.skills || []).join(', '), target_roles: (source.target_roles || []).join(', '), preferred_locations: (source.preferred_locations || []).join(', '), blacklist_companies: (source.blacklist_companies || []).join(', '), min_stipend: source.min_stipend ?? '', min_salary: source.min_salary ?? '', education: educationText(source.education) } : blank);
    setEducationEdited(false);
  }, [profile]);
  const update = event => {
    if (event.target.name === 'education') setEducationEdited(true);
    setForm(current => ({ ...current, [event.target.name]: event.target.value }));
  };
  async function submit(event) {
    event.preventDefault(); setError(''); setSuccess('');
    if (resume && !resume.name.toLowerCase().endsWith('.pdf')) { setError('Choose a PDF resume.'); return; }
    if (resume?.size > (cloud ? 3 : 10) * 1024 * 1024) { setError(`Choose a PDF smaller than ${cloud ? 3 : 10} MB.`); return; }
    const data = { ...form, skills: split(form.skills), target_roles: split(form.target_roles), preferred_locations: split(form.preferred_locations), blacklist_companies: split(form.blacklist_companies), weekly_quota: Number(form.weekly_quota), experience_years: Number(form.experience_years), min_stipend: form.min_stipend === '' ? null : Number(form.min_stipend), min_salary: form.min_salary === '' ? null : Number(form.min_salary), certifications: lines(form.certifications), achievements: lines(form.achievements), languages: commaList(form.languages), links: (form.links || []).filter(nonempty), experience: (form.experience || []).filter(nonempty).map(item => typeof item === 'string' ? item : { ...item, ...(item.bullets != null ? { bullets: lines(item.bullets) } : {}) }), projects: (form.projects || []).filter(nonempty).map(item => ({ ...item, ...(item.tech != null ? { tech: commaList(item.tech) } : {}), ...(item.bullets != null ? { bullets: lines(item.bullets) } : {}) })) };
    if (data.links.some(item => !validLink(item.url))) { setError('Enter a valid HTTP or HTTPS URL for each profile link.'); return; }
    if (data.projects.some(item => ['github', 'live'].some(key => item[key] && !validLink(item[key])))) { setError('Enter valid HTTP or HTTPS project URLs.'); return; }
    if (['skills', 'target_roles', 'preferred_locations', 'blacklist_companies', 'certifications', 'achievements', 'languages'].some(key => data[key].length > 100 || data[key].some(item => item.length > 300))) { setError('Use up to 100 entries per list, with each entry no longer than 300 characters.'); return; }
    if (!educationEdited && profile?.master_profile?.education != null) data.education = profile.master_profile.education;
    if (cloud && !profile && resume) {
      for (const field of ['name', 'email', 'phone', 'education', 'summary']) if (!String(data[field] || '').trim()) delete data[field];
      for (const field of ['skills', 'target_roles', 'preferred_locations', 'experience', 'projects', 'links', 'certifications', 'achievements', 'languages']) if (!data[field].length) delete data[field];
      if (form.experience_years === '') delete data.experience_years;
    }
    let payload = data;
    if (resume) {
      payload = new FormData();
      Object.entries(data).forEach(([key, value]) => {
        if (value != null) payload.append(key, Array.isArray(value) || key === 'education' && value && typeof value === 'object' ? JSON.stringify(value) : value);
        else if (['min_stipend', 'min_salary'].includes(key)) payload.append(key, '');
      });
      payload.append('resume', resume);
    }
    setBusy(true);
    try { const saved = await api.saveProfile(payload, profile?.id); activateProfile(saved); setSuccess(cloud ? 'Profile saved. Your private workspace is ready.' : `Profile saved. Your profile ID is ${saved.id}.`); setResume(null); setUploadKey(key => key + 1); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function openProfile(event) {
    event.preventDefault(); setError(''); setSuccess('');
    try { await selectProfile(existingId); setSuccess('Profile opened.'); } catch (error) { setError(errorMessage(error)); }
  }
  async function signOut() {
    setBusy(true); setError('');
    try { await logoutProfile(); setResume(null); setSuccess('You have signed out. This browser no longer has access to that profile.'); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  const resumeUpload = <><label className="upload-area"><FileUp size={27} aria-hidden="true" /><strong>{resume ? resume.name : 'Add your resume'}</strong><span>Choose a PDF · up to {cloud ? 3 : 10} MB</span><input key={uploadKey} aria-label="Resume PDF" type="file" accept=".pdf,application/pdf" onChange={event => { setResume(event.target.files?.[0] || null); setError(''); }} /></label>{profile?.master_profile?.master_resume_path && <p className="field-help">A resume is already saved. Upload a new PDF to replace it.</p>}</>;
  return <><PageHeading eyebrow="YOUR FOUNDATION" title="A profile that feels like you.">Tell us where you want to go. We’ll help you find the way.</PageHeading>
    {loading && <Loading label="Opening your profile…" />}{(error || profileError) && <ErrorNotice>{error || profileError}</ErrorNotice>}{success && <div className="notice notice-success" role="status"><CheckCircle2 size={19} />{success}</div>}
    {profile?.master_profile?.resume_extraction_warning && <div className="notice notice-info" role="status">{String(profile.master_profile.resume_extraction_warning)}</div>}
    <div className="profile-layout"><form className="panel profile-form" onSubmit={submit}><div className="section-heading"><span className="section-icon"><UserRound size={20} /></span><div><h2>{profile ? 'Your profile' : 'Let’s get acquainted'}</h2><p>A few details make every match more personal.</p></div>{profile && !cloud && <span className="pill">ID {userId}</span>}</div>
      {cloud && !profile && <><h3>Upload your resume to fill your profile</h3><p className="field-help">We’ll fill in the details from your PDF. You can also enter them below.</p>{resumeUpload}<div className="form-divider" /></>}
      <div className="form-grid"><label>Full name<input name="name" value={form.name} onChange={update} placeholder="e.g. Alex Morgan" autoComplete="name" required={Boolean(profile) || !cloud || !resume} maxLength={200} /></label><label>Email address<input name="email" type="email" value={form.email} onChange={update} placeholder="you@example.com" autoComplete="email" required={Boolean(profile) || !cloud || !resume} /></label><label>Phone number<input name="phone" type="tel" value={form.phone || ''} onChange={update} placeholder="Include your country code" autoComplete="tel" /></label><label>Years of experience<input name="experience_years" type="number" min="0" max="80" step="0.5" value={form.experience_years ?? ''} onChange={update} placeholder="0" /></label><label className="full-width">Skills<input name="skills" value={form.skills} onChange={update} placeholder="Python, React, SQL, problem solving" /><span className="field-help">Separate skills with commas. Include the things you enjoy working with.</span></label><label className="full-width">Education<input name="education" value={form.education || ''} onChange={update} placeholder="Degree, university, graduation year" /></label></div>
      <div className="form-divider" /><h3>What are you looking for?</h3><ModeSelector value={form.mode} onChange={mode => setForm(current => ({ ...current, mode }))} />
      <div className="form-grid"><label>Target roles<input name="target_roles" value={form.target_roles} onChange={update} placeholder="AI Engineer, Software Developer" /></label><label>Preferred locations<input name="preferred_locations" value={form.preferred_locations} onChange={update} placeholder="Bengaluru, Remote" /></label><label>Applications per week<input name="weekly_quota" type="number" min="1" max="100" value={form.weekly_quota} onChange={update} required /><span className="field-help">Set a pace you can prepare for. Between 1 and 100.</span></label></div>
      <div className="form-grid profile-preferences"><label>{form.mode === 'internship' ? 'Minimum stipend · INR per month' : 'Minimum salary · INR per year'}<input name={form.mode === 'internship' ? 'min_stipend' : 'min_salary'} type="number" min="0" max="1000000000" step="1" value={form.mode === 'internship' ? form.min_stipend : form.min_salary} onChange={update} placeholder="No minimum" /><span className="field-help">Used when a listing includes compensation information.</span></label><label>Review applications<select name="confirmation_mode" value={form.confirmation_mode} onChange={update}><option value="batch">As a selected batch</option><option value="individual">One opportunity at a time</option></select><span className="field-help">You always review resumes before authorizing submissions.</span></label><label className="full-width">Excluded companies<input name="blacklist_companies" value={form.blacklist_companies} onChange={update} placeholder="Company names, separated by commas" /><span className="field-help">These companies are left out of your weekly plan.</span></label></div>
      <ProfileDetailsEditor form={form} initiallyOpen={Boolean(profile)} onChange={(key, value) => setForm(current => ({ ...current, [key]: value }))} />
      {(!cloud || profile) && <><div className="form-divider" /><h3>Your starting resume</h3>{resumeUpload}</>}
      <footer className="form-footer"><p>You’ll review your plan before applications are submitted.</p><button className="button" disabled={busy || loading} type="submit"><Save size={17} />{busy ? 'Saving…' : 'Save profile'}</button></footer>
    </form><aside className="profile-aside"><div className="gentle-card"><span className="eyebrow">A LITTLE INTENTION GOES FAR</span><h2>Better matches.<br />More meaningful moves.</h2><p>Your skills and preferences shape every opportunity, every resume, and every prep guide.</p><ol><li><span>01</span>Build your profile</li><li><span>02</span>Review your weekly plan</li><li><span>03</span>Apply with confidence</li></ol></div>
      {cloud ? <section className="panel small-panel"><h3>Your private workspace</h3><p>Your profile is saved securely in this browser.</p>{profile ? <><p>You are signed in as {profile.email}.</p><button type="button" className="button button-secondary" disabled={busy || loading} onClick={signOut}>Sign out</button><p className="field-help">Signing out ends access to this profile in this browser.</p></> : <><p>Upload your resume and save your profile to get started. Return in this browser to continue.</p>{previousWorkspace() && <a className="button button-secondary" href={previousWorkspace()}>Continue an existing workspace <ArrowRight size={16} /></a>}</>}</section> : <form className="panel small-panel" onSubmit={openProfile}><h3>Already have a profile?</h3><p>Open it with the profile ID from your last visit.</p><label>Profile ID<input type="number" min="1" value={existingId} onChange={event => setExistingId(event.target.value)} required placeholder="e.g. 1" /></label><button type="submit" className="button button-secondary" disabled={loading}>Open profile <ArrowRight size={16} /></button>{profile && <button type="button" className="text-button" onClick={() => { clearProfile(); setSuccess(''); setResume(null); }}>Create a different profile</button>}</form>}
    </aside></div>
  </>;
}
