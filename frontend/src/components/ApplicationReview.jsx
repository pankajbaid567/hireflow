import { useEffect, useRef, useState } from 'react';
import { FileText, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { api, artifactUrl, errorMessage } from '../api/client';
import ProfileDetailsEditor from './ProfileDetailsEditor';
import { ErrorNotice, Loading } from './UI';

const array = value => Array.isArray(value) ? value : typeof value === 'string' ? value.split('\n').map(item => item.trim()).filter(Boolean) : [];
const comma = value => typeof value === 'string' ? value.split(',').map(item => item.trim()).filter(Boolean) : array(value);
const display = value => Array.isArray(value) ? value.map(display).filter(Boolean).join('\n') : value && typeof value === 'object' ? Object.values(value).map(display).filter(Boolean).join(' · ') : String(value ?? '');
function compareText(draft) {
  return ['summary', 'skills', 'experience', 'projects', 'education', 'certifications', 'achievements', 'languages'].filter(key => draft?.[key]).map(key => `${key.toUpperCase()}\n${display(draft[key])}`).join('\n\n');
}
function savedDraft(draft) {
  return { ...draft, skills: comma(draft.skills), languages: comma(draft.languages), certifications: array(draft.certifications), achievements: array(draft.achievements),
    experience: array(draft.experience).map(item => typeof item === 'object' ? { ...item, ...(item.bullets != null ? { bullets: array(item.bullets) } : {}) } : item),
    projects: array(draft.projects).map(item => typeof item === 'object' ? { ...item, ...(item.tech != null ? { tech: comma(item.tech) } : {}), ...(item.bullets != null ? { bullets: array(item.bullets) } : {}) } : item) };
}
export default function ApplicationReview({ job, onClose, onUpdated }) {
  const [data, setData] = useState(null), [draft, setDraft] = useState({}), [answers, setAnswers] = useState([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [tab, setTab] = useState('review'), [checked, setChecked] = useState(false), [dirty, setDirty] = useState(false);
  const dialog = useRef(null), close = useRef(null);
  function accept(value) { setData(value); setDraft(value.draft); setAnswers(value.questions || []); setChecked(false); setDirty(false); }
  useEffect(() => {
    let active = true;
    api.getApplicationReview(job.application_id).then(value => { if (active) accept(value); }).catch(error => { if (active) setError(errorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [job.application_id]);
  useEffect(() => {
    const previous = document.activeElement, overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; close.current?.focus();
    function key(event) {
      if (event.key === 'Escape' && !busy) onClose();
      if (event.key !== 'Tab') return;
      const controls = [...(dialog.current?.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea') || [])];
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose, busy]);
  const changeDraft = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setDirty(true); setChecked(false); };
  async function action(operation) {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  async function save() {
    await action(async () => {
      await api.editResume(job.application_id, { base_version: data.resume_version, profile_version: data.profile_version, draft: savedDraft(draft) });
      accept(await api.getApplicationReview(job.application_id)); await onUpdated();
      setMessage('A new PDF version is saved. Open it and review the answers before approving.'); setTab('review');
    });
  }
  async function approve() {
    await action(async () => {
      if (dirty) throw new Error('Save your resume changes and review the new PDF first.');
      const values = {};
      for (const item of answers) { if (item.question.trim() && item.answer.trim()) { if (Object.hasOwn(values,item.question)) throw new Error('Use each question once.'); values[item.question] = item.answer; } }
      await api.approveApplicationReview(job.application_id, { resume_version: data.resume_version, profile_version: data.profile_version, answers: values, reviewed: checked });
      await onUpdated(); onClose();
    });
  }
  // The authenticated URL from the plan already includes the current owner.
  const pdf = data ? artifactUrl((job.resume_url || '').replace(/\?.*$/, '') + `?version=${data.resume_version}`) : null;
  return <div className="modal-overlay"><section ref={dialog} className="resume-modal application-review" role="dialog" aria-modal="true" aria-labelledby="application-review-title"><header><div><h2 id="application-review-title">Review {job.company_name || job.company}</h2><p>{job.role_title || job.role}{data && ` · Resume v${data.resume_version}`}</p></div><button ref={close} type="button" className="icon-button" aria-label="Close application review" disabled={busy} onClick={onClose}><X /></button></header>
    <div className="review-body">{loading && <Loading label="Loading your resume and application answers…" />}{error && <ErrorNotice>{error}</ErrorNotice>}{message && <div className="notice notice-success" role="status">{message}</div>}
      {data && <><div className="button-row review-tabs" role="group" aria-label="Application review sections">{[['review','PDF and answers'],['edit','Edit this resume'],['compare','Compare versions']].map(([value,label]) => <button type="button" className={`button button-small ${tab===value?'':'button-secondary'}`} key={value} onClick={()=>setTab(value)}>{label}</button>)}</div>
      {data.rejected && <div className="notice notice-info" role="status">This resume is rejected. Edit it or request a new draft before approval.</div>}
      {tab==='review' && <><p>Review the exact PDF and answers that may be submitted. Unreviewed questions will need your action.</p>{pdf && <a className="button button-secondary button-small" href={pdf} target="_blank" rel="noopener noreferrer"><FileText size={15}/>Open PDF v{data.resume_version}</a>}<div className="review-answers"><h3>Application answers</h3><p className="field-help">These drafts use your resume facts. Correct them as needed. Leave unknown eligibility or personal answers blank.</p>{answers.map((item,index)=><fieldset className="review-answer" key={index}><label>Question<input aria-label={`Question ${index+1}`} maxLength={250} value={item.question} onChange={event=>{setAnswers(current=>current.map((entry,pos)=>pos===index?{...entry,question:event.target.value}:entry));setChecked(false);}}/></label><label>Reviewed answer<textarea aria-label={`Answer ${index+1}`} rows={4} maxLength={3000} value={item.answer} onChange={event=>{setAnswers(current=>current.map((entry,pos)=>pos===index?{...entry,answer:event.target.value}:entry));setChecked(false);}}/></label><button type="button" className="text-button" aria-label={`Remove question ${index+1}`} onClick={()=>{setAnswers(current=>current.filter((_,pos)=>pos!==index));setChecked(false);}}><Trash2 size={14}/>Remove question</button></fieldset>)}<button type="button" className="text-button" disabled={answers.length>=30} onClick={()=>{setAnswers(current=>[...current,{question:'',answer:''}]);setChecked(false);}}><Plus size={15}/>Add a question</button></div><label className="review-consent"><input type="checkbox" checked={checked} disabled={busy||dirty||data.rejected} onChange={event=>setChecked(event.target.checked)}/>I reviewed PDF v{data.resume_version} and these answers. I approve this version for the selected opportunity.</label><button type="button" className="button" disabled={busy||!checked||dirty||data.rejected} onClick={approve}><ShieldCheck size={16}/>{busy?'Saving…':'Approve PDF and answers'}</button></>}
      {tab==='edit' && <><p>These changes affect this opportunity only. Your master profile and previously submitted PDFs stay unchanged.</p><label>Skills · separated by commas<input aria-label="Resume skills" value={Array.isArray(draft.skills)?draft.skills.join(', '):draft.skills||''} onChange={event=>changeDraft('skills',event.target.value)}/></label><label>Education<textarea aria-label="Resume education" rows={3} value={display(draft.education)} onChange={event=>changeDraft('education',event.target.value)}/></label><ProfileDetailsEditor form={draft} initiallyOpen onChange={changeDraft} helpText="Keep every claim accurate. Saving creates a new PDF for this opportunity and requires another review."/><button type="button" className="button" disabled={busy||!dirty} onClick={save}><Save size={16}/>Save new PDF version</button></>}
      {tab==='compare' && <><p>Compare your current edits with the previous saved version. Unsaved edits are not submitted.</p><div className="resume-comparison"><section><h3>{dirty?'Saved version':'Previous version'}</h3><pre>{compareText(dirty?data.draft:data.previous_draft)||'No previous version is available.'}</pre></section><section><h3>{dirty?'Your edits':`Current v${data.resume_version}`}</h3><pre>{compareText(draft)}</pre></section></div><h3>Saved PDFs</h3><ul>{(data.versions||[]).map(version=><li key={version.version}><a href={artifactUrl(version.download_url)} target="_blank" rel="noopener noreferrer">Version {version.version}</a> · {version.method==='user_edited'?'Edited by you':version.method==='llm_grounded'?'AI-selected facts':'Profile facts'}<p>{version.summary}</p></li>)}</ul></>}
      <div className="review-maintenance"><button type="button" className="text-button" disabled={busy||data.rejected} onClick={()=>action(async()=>{await api.rejectResume(job.application_id,data.resume_version);setData(current=>({...current,rejected:true}));setChecked(false);await onUpdated();})}><Trash2 size={14}/>Reject this PDF</button><button type="button" className="text-button" disabled={busy} onClick={()=>action(async()=>{await api.regenerateResume(job.application_id,data.resume_version);await onUpdated();onClose();})}><RefreshCw size={14}/>Request a new draft</button><p className="field-help">New drafts use bounded provider retries. You must review each new PDF before applying.</p></div></>}
    </div></section></div>;
}
