import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import AccountSecurity from '../components/AccountSecurity';
import RecoverWorkspace from '../components/RecoverWorkspace';
const webauthn=vi.hoisted(()=>({browserSupportsWebAuthn:vi.fn(()=>true),startRegistration:vi.fn(),startAuthentication:vi.fn()}));
vi.mock('@simplewebauthn/browser',()=>webauthn);
const security={passkeys:[],sessions:[{id:'session-1',label:'Chrome',current:true,expires_at:'2027-01-01'}],recovery_keys:{remaining:0,expires_at:null}};
function client(){return{getAccountSecurity:vi.fn().mockResolvedValue(security),createPasskeyOptions:vi.fn().mockResolvedValue({challenge_id:'registration',options:{challenge:'register-challenge'}}),registerPasskey:vi.fn().mockResolvedValue({registered:true}),deletePasskey:vi.fn().mockResolvedValue({deleted:true}),rotateRecoveryKeys:vi.fn().mockResolvedValue({recovery_keys:['hf-recovery-private-once'],expires_at:'2027-01-01'}),revokeSession:vi.fn().mockResolvedValue({revoked:true}),revokeAllSessions:vi.fn().mockResolvedValue({authenticated:false}),passkeyLoginOptions:vi.fn().mockResolvedValue({challenge_id:'login',options:{challenge:'login-challenge'}}),passkeyLoginVerify:vi.fn().mockResolvedValue({authenticated:true,user_id:7}),recoverWorkspace:vi.fn().mockResolvedValue({authenticated:true,user_id:7})};}
beforeEach(()=>{vi.clearAllMocks();webauthn.browserSupportsWebAuthn.mockReturnValue(true);webauthn.startRegistration.mockResolvedValue({id:'real-browser-credential'});webauthn.startAuthentication.mockResolvedValue({id:'signed-browser-assertion'});});
describe('account security controls',()=>{
 it('enrolls only through browser registration and the server challenge, then displays success',async()=>{
  const api=client();render(<AccountSecurity api={api}/>);await screen.findByText('0 unused keys available.');fireEvent.change(screen.getByLabelText('Passkey name'),{target:{value:'Laptop'}});fireEvent.click(screen.getByRole('button',{name:'Add a passkey'}));
  await waitFor(()=>expect(api.registerPasskey).toHaveBeenCalledWith({challenge_id:'registration',credential:{id:'real-browser-credential'},name:'Laptop'}));expect(webauthn.startRegistration).toHaveBeenCalledWith({optionsJSON:{challenge:'register-challenge'}});await screen.findByText(/Passkey added/);
 });
 it('shows generated recovery keys once, then removes their raw values from the page',async()=>{
  const api=client();render(<AccountSecurity api={api}/>);await screen.findByText('0 unused keys available.');fireEvent.click(screen.getByRole('button',{name:'Generate recovery keys'}));
  const keys=await screen.findByLabelText('Recovery keys to save');expect(keys.value).toBe('hf-recovery-private-once');fireEvent.click(screen.getByRole('button',{name:'I saved these keys'}));expect(screen.queryByLabelText('Recovery keys to save')).toBeNull();expect(localStorage.getItem('recovery_keys')).toBeNull();
 });
 it('revokes all sessions through an explicit owner action and clears the current workspace',async()=>{
  const api=client(),signedOut=vi.fn();render(<AccountSecurity api={api} onSignedOut={signedOut}/>);await screen.findByText('0 unused keys available.');fireEvent.click(screen.getByRole('button',{name:'Sign out all devices'}));await waitFor(()=>expect(signedOut).toHaveBeenCalledOnce());expect(api.revokeAllSessions).toHaveBeenCalledOnce();
 });
 it('does not offer unavailable Python passkeys and retains recovery-key controls',async()=>{
  const api=client();api.getAccountSecurity.mockResolvedValue({...security,capabilities:{passkeys:false}});render(<AccountSecurity api={api}/>);await screen.findByText('0 unused keys available.');expect(screen.queryByRole('button',{name:'Add a passkey'})).toBeNull();expect(screen.getByRole('button',{name:'Generate recovery keys'})).toBeEnabled();
 });
});
describe('lost-session recovery',()=>{
 it('recovers with a saved key without accepting an email, ID or operator credential',async()=>{
  const api=client(),recovered=vi.fn();render(<RecoverWorkspace api={api} onRecovered={recovered}/>);expect(screen.queryByRole('textbox',{name:/email|profile id|access code/i})).toBeNull();fireEvent.change(screen.getByLabelText('Recovery key'),{target:{value:' hf-recovery-private-once '}});fireEvent.click(screen.getByRole('button',{name:'Use recovery key'}));await waitFor(()=>expect(recovered).toHaveBeenCalledWith({authenticated:true,user_id:7}));expect(api.recoverWorkspace).toHaveBeenCalledWith({recovery_key:'hf-recovery-private-once'});expect(screen.getByLabelText('Recovery key').value).toBe('');
 });
 it('uses a browser passkey assertion and activates only the verified server result',async()=>{
  const api=client(),recovered=vi.fn();render(<RecoverWorkspace api={api} onRecovered={recovered}/>);fireEvent.click(screen.getByRole('button',{name:'Continue with a passkey'}));await waitFor(()=>expect(recovered).toHaveBeenCalledWith({authenticated:true,user_id:7}));expect(api.passkeyLoginVerify).toHaveBeenCalledWith({challenge_id:'login',credential:{id:'signed-browser-assertion'}});
 });
 it('keeps the workspace signed out after failed recovery and shows the safe server error',async()=>{
  const api=client(),recovered=vi.fn();api.recoverWorkspace.mockRejectedValue({response:{data:{detail:'This recovery key is invalid, expired or already used.'}}});render(<RecoverWorkspace api={api} onRecovered={recovered} passkeysEnabled={false}/>);expect(screen.queryByRole('button',{name:'Continue with a passkey'})).toBeNull();fireEvent.change(screen.getByLabelText('Recovery key'),{target:{value:'used-key'}});fireEvent.click(screen.getByRole('button',{name:'Use recovery key'}));await screen.findByRole('alert');expect(recovered).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('already used');
 });
});
