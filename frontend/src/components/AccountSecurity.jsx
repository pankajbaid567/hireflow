import { useEffect, useState } from 'react';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { api as defaultApi, errorMessage } from '../api/client';

export default function AccountSecurity({ api = defaultApi, onSignedOut = () => {} }) {
  const [security, setSecurity] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('Personal device');
  const [keys, setKeys] = useState([]);
  const passkeysEnabled = security?.capabilities?.passkeys !== false;
  useEffect(() => { let active = true; api.getAccountSecurity().then(data => { if (active) setSecurity(data); }).catch(error => { if (active) setError(errorMessage(error)); }); return () => { active = false; }; }, [api]);
  async function action(work) {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  const reload = async () => setSecurity(await api.getAccountSecurity());
  async function addPasskey() {
    await action(async () => {
      const options = await api.createPasskeyOptions();
      const credential = await startRegistration({ optionsJSON: options.options });
      await api.registerPasskey({ challenge_id: options.challenge_id, credential, name });
      await reload(); setNotice('Passkey added. You can use it to recover this workspace on another device.');
    });
  }
  async function generateKeys() {
    await action(async () => {
      const result = await api.rotateRecoveryKeys(); setKeys(result.recovery_keys); await reload();
      setNotice('New recovery keys created. All previous recovery keys have been invalidated.');
    });
  }
  return <section className="panel account-security" aria-labelledby="account-security-heading">
    <h2 id="account-security-heading">Account security and recovery</h2>
    <p>Add a passkey and save recovery keys before clearing browser data or changing devices. Your email address alone cannot recover this workspace.</p>
    {error && <p role="alert" className="notice notice-error">{error}</p>}
    {notice && <p role="status" className="notice notice-success">{notice}</p>}
    {!security && !error && <p role="status">Loading account security…</p>}
    {passkeysEnabled && <><h3>Passkeys</h3>
    <p>Your device verifies your identity. HireFlow stores the public key; biometric data stays on your device.</p>
    <label>Passkey name<input value={name} maxLength={80} onChange={event => setName(event.target.value)} disabled={busy} /></label>
    <button className="button button-secondary" type="button" disabled={busy || !browserSupportsWebAuthn()} onClick={addPasskey}>Add a passkey</button>
    {!browserSupportsWebAuthn() && <p>This browser does not support passkeys. Save recovery keys instead.</p>}
    <ul>{(security?.passkeys || []).map(key => <li key={key.id}>{key.name} <button type="button" disabled={busy} aria-label={`Remove passkey ${key.name}`} onClick={() => action(async () => { await api.deletePasskey(key.id); await reload(); })}>Remove</button></li>)}</ul></>}
    <h3>Recovery keys</h3>
    <p>Each key can be used once and expires after one year. Recovery signs out existing sessions. Save the keys in a password manager or another private place.</p>
    {security && <p>{security.recovery_keys?.remaining || 0} unused keys available.</p>}
    <button className="button button-secondary" type="button" disabled={busy} onClick={generateKeys}>{security?.recovery_keys?.remaining ? 'Replace recovery keys' : 'Generate recovery keys'}</button>
    {keys.length > 0 && <div role="region" aria-label="New recovery keys">
      <p>These keys are shown only now. Replacing them invalidates every previous key.</p>
      <textarea readOnly aria-label="Recovery keys to save" value={keys.join('\n')} rows={keys.length} spellCheck={false} autoComplete="off" />
      <button type="button" onClick={() => { setKeys([]); setNotice('Recovery keys hidden. Keep your saved copy private.'); }}>I saved these keys</button>
    </div>}
    <h3>Active sessions</h3>
    <ul>{(security?.sessions || []).map(session => <li key={session.id}>{session.label || 'Browser session'}{session.current ? ' (this device)' : ''} — expires {new Date(session.expires_at).toLocaleDateString()} <button type="button" disabled={busy} aria-label={`Revoke session ${session.label || 'Browser session'}${session.current ? ' this device' : ''}`} onClick={() => action(async () => { await api.revokeSession(session.id); if (session.current) await onSignedOut(); else await reload(); })}>Sign out</button></li>)}</ul>
    <button className="button button-secondary" type="button" disabled={busy} onClick={() => action(async () => { await api.revokeAllSessions(); setKeys([]); await onSignedOut(); })}>Sign out all devices</button>
  </section>;
}
