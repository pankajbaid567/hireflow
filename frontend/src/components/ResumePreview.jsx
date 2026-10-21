import { useEffect, useRef } from 'react';
import { Download, X } from 'lucide-react';
import { artifactUrl } from '../api/client';

export default function ResumePreview({ url, title = 'Tailored resume', onClose }) {
  const close = useRef(null);
  const href = artifactUrl(url);
  useEffect(() => {
    const previous = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    close.current?.focus();
    const onKey = event => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const controls = [...document.querySelectorAll('[data-resume-dialog] a, [data-resume-dialog] button, [data-resume-dialog] iframe')];
        const first = controls[0]; const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', onKey); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-overlay" onClick={event => { if (event.target === event.currentTarget) onClose(); }}><section className="resume-modal" data-resume-dialog role="dialog" aria-modal="true" aria-labelledby="resume-title"><header><h2 id="resume-title">{title}</h2><div className="button-row">{href && <a className="button button-secondary button-small" href={href} target="_blank" rel="noopener noreferrer"><Download size={15} />Open PDF</a>}<button ref={close} className="icon-button" aria-label="Close resume preview" onClick={onClose}><X /></button></div></header>{href ? <iframe title={title} src={href} /> : <p>Resume preview is unavailable.</p>}</section></div>;
}
