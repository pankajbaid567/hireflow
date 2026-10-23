import { useState } from 'react';
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';
import { api as defaultApi, errorMessage } from '../api/client';

export default function RecoverWorkspace({ api = defaultApi, onRecovered = () => {}, passkeysEnabled = true }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function recover(work) {
    setBusy(true); setError('');
    try { const result = await work(); setKey(''); await onRecovered(result); }
    catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <section className="card" aria-labelledby="recover-workspace-heading">
    <h2 id="recover-workspace-heading">Recover your workspace</h2>
    <p>Use a passkey or an unused recovery key you saved from your account. Your email address or profile number cannot grant access.</p>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {passkeysEnabled && <button className="button button-secondary" type="button" disabled={busy || !browserSupportsWebAuthn()} onClick={() => recover(async () => {
      const options = await api.passkeyLoginOptions();
      const credential = await startAuthentication({ optionsJSON: options.options });
      return api.passkeyLoginVerify({ challenge_id: options.challenge_id, credential });
    })}>Continue with a passkey</button>}
    <form onSubmit={event => { event.preventDefault(); recover(() => api.recoverWorkspace({ recovery_key: key.trim() })); }}>
      <label>Recovery key<input type="password" value={key} onChange={event => setKey(event.target.value)} autoComplete="off" spellCheck={false} maxLength={100} required disabled={busy} /></label>
      <button className="button button-secondary" type="submit" disabled={busy || !key.trim()}>Use recovery key</button>
    </form>
    <p>If you have no saved recovery method, an email address alone cannot prove ownership. Use an existing signed-in browser to add a passkey or generate recovery keys.</p>
  </section>;
}
