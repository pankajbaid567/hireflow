import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, errorMessage, isCloudflare } from '../api/client';

export const ProfileContext = createContext(null);
const STORAGE_KEY = 'hireflow.userId';
let pendingTransfer = null;
async function restoreCloudSession() {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('transfer');
  if (token) {
    // Fragments never enter HTTP/referrer logs; clear it from browser history
    // immediately. Share the request across React StrictMode's effect replay.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('This workspace transfer link is invalid. Continue from your previous workspace again.');
    pendingTransfer ||= api.consumeTransfer(token).finally(() => { pendingTransfer = null; });
  }
  if (pendingTransfer) await pendingTransfer;
  return api.getSession();
}
export function ProfileProvider({ children }) {
  const [userId, setUserId] = useState('');
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const activateProfile = useCallback(profile => {
    const id = String(profile.id);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    setUserId(id); setProfile(profile); setError('');
  }, []);
  const clearProfile = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    setUserId(''); setProfile(null); setError('');
  }, []);
  const selectProfile = useCallback(async id => {
    setLoading(true); setError('');
    try { const data = await api.getProfile(id); activateProfile(data); return data; }
    catch (error) { setError(errorMessage(error)); throw error; }
    finally { setLoading(false); }
  }, [activateProfile]);
  const logoutProfile = useCallback(async () => {
    await api.logoutSession();
    clearProfile();
  }, [clearProfile]);
  useEffect(() => {
    let active = true;
    {
      // A cached numeric ID is never used as proof of ownership.
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
      (isCloudflare()?restoreCloudSession():api.getSession()).then(async session => {
        if (!session.authenticated || !session.user_id) return;
        const data = await api.getProfile(session.user_id);
        if (active) activateProfile(data);
      }).catch(error => { if (active) setError(errorMessage(error)); })
        .finally(() => { if (active) setLoading(false); });
    }
    return () => { active = false; };
  }, []);
  return <ProfileContext.Provider value={{ userId, profile, loading, error, activateProfile, selectProfile, clearProfile, logoutProfile }}>{children}</ProfileContext.Provider>;
}
export function useProfile() { return useContext(ProfileContext); }
