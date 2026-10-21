import { BriefcaseBusiness, GraduationCap } from 'lucide-react';
export default function ModeSelector({ value, onChange }) {
  return <div className="mode-selector" role="radiogroup" aria-label="Opportunity mode">
    {[['internship', 'Internship', GraduationCap, 'Learn by doing'], ['job', 'Job', BriefcaseBusiness, 'Your next chapter']].map(([mode, label, Icon, detail]) => <button key={mode} type="button" role="radio" aria-checked={value === mode} className={`mode-option ${value === mode ? 'selected' : ''}`} onClick={() => onChange(mode)}><Icon size={22} aria-hidden="true" /><span><strong>{label}</strong><small>{detail}</small></span><span className="radio-dot" /></button>)}
  </div>;
}
