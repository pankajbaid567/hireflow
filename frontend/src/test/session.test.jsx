import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProfileProvider, useProfile } from '../context/ProfileContext';
import { api } from '../api/client';

vi.mock('../api/client', async importOriginal => ({ ...await importOriginal(), isCloudflare: () => true, api: { getSession: vi.fn(), getProfile: vi.fn(), logoutSession: vi.fn(), consumeTransfer: vi.fn() } }));
function State() {
  const { userId, loading, logoutProfile } = useProfile();
  return <><p>{loading ? 'Restoring' : userId ? `Profile ${userId}` : 'Signed out'}</p><button onClick={logoutProfile}>Sign out</button></>;
}
beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/profile'); });
describe('private browser session restoration', () => {
  it('consumes a migration fragment only once under StrictMode and removes it from history', async () => {
    const token='a'.repeat(64);
    window.history.replaceState(null,'',`/profile#transfer=${token}`);
    api.consumeTransfer.mockResolvedValue({authenticated:true,user_id:7});
    api.getSession.mockResolvedValue({authenticated:true,user_id:7});api.getProfile.mockResolvedValue({id:7});
    render(<StrictMode><ProfileProvider><State /></ProfileProvider></StrictMode>);
    expect(await screen.findByText('Profile 7')).toBeInTheDocument();
    expect(api.consumeTransfer).toHaveBeenCalledTimes(1);expect(api.consumeTransfer).toHaveBeenCalledWith(token);
    expect(window.location.hash).toBe('');
  });
  it('does not restore ownership from a malformed transfer token',async()=>{
    window.history.replaceState(null,'','/profile#transfer=invalid');
    render(<ProfileProvider><State /></ProfileProvider>);
    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    expect(api.consumeTransfer).not.toHaveBeenCalled();expect(api.getSession).not.toHaveBeenCalled();expect(window.location.hash).toBe('');
  });
  it('ignores a cached profile ID when there is no authenticated session', async () => {
    localStorage.setItem('hireflow.userId', '999'); api.getSession.mockResolvedValue({ authenticated: false });
    render(<ProfileProvider><State /></ProfileProvider>);
    expect(await screen.findByText('Signed out')).toBeInTheDocument(); expect(api.getProfile).not.toHaveBeenCalled(); expect(localStorage.getItem('hireflow.userId')).toBeNull();
  });
  it('restores only the session owner and logs out through the API', async () => {
    api.getSession.mockResolvedValue({ authenticated: true, user_id: 7 }); api.getProfile.mockResolvedValue({ id: 7 }); api.logoutSession.mockResolvedValue({});
    render(<ProfileProvider><State /></ProfileProvider>);
    expect(await screen.findByText('Profile 7')).toBeInTheDocument(); expect(api.getProfile).toHaveBeenCalledWith(7);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' })); expect(api.logoutSession).toHaveBeenCalled(); expect(await screen.findByText('Signed out')).toBeInTheDocument();
  });
  it('does not recover a profile from browser storage if session restoration fails', async () => {
    localStorage.setItem('hireflow.userId', '7'); api.getSession.mockRejectedValue(new Error('Session unavailable.'));
    render(<ProfileProvider><State /></ProfileProvider>);
    expect(await screen.findByText('Signed out')).toBeInTheDocument();
    expect(api.getProfile).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  });
});
