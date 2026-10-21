import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';

export const ProfileContext = createContext(null);
const STORAGE_KEY = 'hireflow.userId';
function storedId() {
  try { return localStorage.getItem(STORAGE_KEY) || ''; } catch { return ''; }
}
export function ProfileProvider({ children }) {
  const [userId, setUserId] = useState(storedId);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const activateProfile = useCallback(profile => {
    const id = String(profile.id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* Storage may be disabled. */ }
    setUserId(id); setProfile(profile); setError('');
  }, []);
  const selectProfile = useCallback(async id => {
    setLoading(true); setError('');
    try { const data = await api.getProfile(id); activateProfile(data); return data; }
    catch (error) { setError(errorMessage(error)); throw error; }
    finally { setLoading(false); }
  }, [activateProfile]);
  const clearProfile = useCallback(() => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Storage may be disabled. */ }
    setUserId(''); setProfile(null); setError('');
  }, []);
  useEffect(() => {
    if (userId) selectProfile(userId).catch(() => {});
  }, []); // Restore only on first mount. Selection and saves update the context directly.
  return <ProfileContext.Provider value={{ userId, profile, loading, error, activateProfile, selectProfile, clearProfile }}>{children}</ProfileContext.Provider>;
}
export function useProfile() { return useContext(ProfileContext); }
