// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { isMigrationBridgeRequest, migrateWorkspace } from './workspace-migration';
const origin='https://hireflow-api.example.workers.dev';
const old='https://hireflow-blue-seven.vercel.app';
const next='https://hireflow-dashboard.pages.dev';
describe('existing workspace migration bridge',()=>{
  it('forwards only the existing cookie to create a token, then redirects to the fixed new host',async()=>{
    const token='a'.repeat(64);const fetcher=vi.fn().mockResolvedValue(Response.json({transfer_url:`${next}/profile#transfer=${token}`}));
    const request=new Request(`${old}/api/proxy?__hireflow_path=workspace-migrate`,{headers:{Cookie:'hireflow_session=existing','X-HireFlow-Access-Code':'caller'}});
    expect(isMigrationBridgeRequest(request)).toBe(true);
    const response=await migrateWorkspace(request,{origin,workspaceAccessCode:'private-bootstrap',fetcher});
    expect(response.status).toBe(303);expect(response.headers.get('location')).toBe(`${next}/profile#transfer=${token}`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const [url,init]=fetcher.mock.calls[0];expect(url.href).toBe(`${origin}/session/transfer`);expect(init.method).toBe('POST');
    expect(init.headers.get('cookie')).toBe('hireflow_session=existing');expect(init.headers.has('x-hireflow-access-code')).toBe(false);
  });
  it('sends signed-out visitors to the new profile page without minting ownership',async()=>{
    const response=await migrateWorkspace(new Request(`${old}/api/workspace-migrate`),{origin,fetcher:vi.fn().mockResolvedValue(Response.json({}, {status:401}))});
    expect(response.status).toBe(303);expect(response.headers.get('location')).toBe(`${next}/profile`);
  });
  it('rejects alternate destinations and malformed transfer links',async()=>{
    for(const transfer_url of ['https://attacker.example/profile#transfer='+'a'.repeat(64),`${next}/profile#transfer=invalid`]){
      const response=await migrateWorkspace(new Request(`${old}/api/workspace-migrate`),{origin,fetcher:vi.fn().mockResolvedValue(Response.json({transfer_url}))});
      expect(response.status).toBe(502);expect(response.headers.has('location')).toBe(false);
    }
  });
});
