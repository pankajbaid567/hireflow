/** Wiring/security checks; actual Chromium hydration lives in dynamic-source tests. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Env} from '../src/types';
import {verifyDiscoveryDetail} from '../src/intelligence';
import {SourceDeferred} from '../src/source_reader';
import {readDynamicPublicSource,DynamicSourceRejected} from '../src/dynamic_source';
vi.mock('../src/dynamic_source',()=>({
 readDynamicPublicSource:vi.fn(),
 DynamicSourceRejected:class extends Error{constructor(readonly code:string){super('Synthetic rejection');}},
}));
const hydrate=vi.mocked(readDynamicPublicSource),url='https://careers.example.com/jobs/role-314';
const candidate={url,title:'Loading source',company:'Search label must not replace source facts'};
const env={DYNAMIC_SOURCE_ENABLED:'true',DYNAMIC_SOURCE_HOSTS:'careers.example.com',BROWSER_ENABLED:'true'} as Env;
const description='Build a Python API with SQL validation and automated tests in a supervised engineering internship. '.repeat(4).trim();
const posting={'@type':'JobPosting',title:'Python Engineer Intern',hiringOrganization:{name:'Actual Source Company'},description,employmentType:'INTERN',jobLocation:{address:{addressCountry:'IN'}}};
const html=(value:unknown)=>`<script type="application/ld+json">${JSON.stringify(value)}</script>`;
beforeEach(()=>{vi.resetAllMocks();vi.stubGlobal('fetch',vi.fn(()=>new Response('<main>Loading the job…</main>')));hydrate.mockResolvedValue(new Response(html(posting),{headers:{'X-HireFlow-Source-URL':url,'X-HireFlow-Dynamic-Method':'hydrated_json_ld','X-HireFlow-Fetched-At':'2026-10-26T16:00:00Z'}}));});
afterEach(()=>vi.unstubAllGlobals());
describe('rendered public detail integration',()=>{
 it('uses observed hydrated full-JD facts and explicit provenance',async()=>{
  const job=await verifyDiscoveryDetail(env,candidate);expect(job).toMatchObject({title:'Python Engineer Intern',company:'Actual Source Company',description,location:'India',provenance:{kind:'rendered_json_ld',rendered_method:'hydrated_json_ld'}});
  expect(hydrate).toHaveBeenCalledWith(env,url,expect.objectContaining({timeoutMs:expect.any(Number),initialDocument:{url,body:'<main>Loading the job…</main>'}}));
 });
 it.each([401,403,404])('never opens a browser after native HTTP %i',async status=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Response('Unavailable',{status})));expect(await verifyDiscoveryDetail(env,candidate)).toBeNull();expect(hydrate).not.toHaveBeenCalled();
 });
 it.each(['Verify you are human','Sign in to view the job','This position has been filled'])('does not use rendering to bypass a source interstitial: %s',async body=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Response(`<main>${body}</main>`)));expect(await verifyDiscoveryDetail(env,candidate)).toBeNull();expect(hydrate).not.toHaveBeenCalled();
 });
 it('does not launch when disabled or replace complete native JobPosting metadata',async()=>{
  await verifyDiscoveryDetail({...env,DYNAMIC_SOURCE_ENABLED:'false'},candidate);expect(hydrate).not.toHaveBeenCalled();
  vi.stubGlobal('fetch',vi.fn(()=>new Response(html(posting))));expect(await verifyDiscoveryDetail(env,candidate)).toMatchObject({provenance:{kind:'json_ld'}});expect(hydrate).not.toHaveBeenCalled();
 });
 it('propagates a temporary source deferral to the durable cycle',async()=>{
  const failure=new SourceDeferred('Shared source allowance unavailable.',30);hydrate.mockRejectedValue(failure);await expect(verifyDiscoveryDetail(env,candidate)).rejects.toBe(failure);
 });
 it('rejects an unsafe/restricted rendered result without falling back to native shell text',async()=>{
  const trace=vi.fn();hydrate.mockRejectedValue(new DynamicSourceRejected('restricted'));expect(await verifyDiscoveryDetail(env,candidate,trace)).toBeNull();expect(trace).toHaveBeenCalledWith(expect.objectContaining({reason:'rendered_restricted'}));
 });
 it('still rejects expired jobs and invalid final listing URLs after hydration',async()=>{
  hydrate.mockResolvedValueOnce(new Response(html({...posting,validThrough:'2020-01-01'}),{headers:{'X-HireFlow-Dynamic-Method':'hydrated_json_ld'}}));expect(await verifyDiscoveryDetail(env,candidate)).toBeNull();
  hydrate.mockResolvedValueOnce(new Response(html(posting),{headers:{'X-HireFlow-Source-URL':'https://careers.example.com/search','X-HireFlow-Dynamic-Method':'hydrated_json_ld'}}));expect(await verifyDiscoveryDetail(env,candidate)).toBeNull();
 });
 it('never promotes navigation-heavy JavaScript shell text when rendering is not configured',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Response('<div id="root"><p>Loading job details, please wait.</p>'+('Browse teams and countries. Manage cookies and account settings. '.repeat(12))+'</div>')));
  hydrate.mockResolvedValue(null);expect(await verifyDiscoveryDetail(env,candidate)).toBeNull();
 });
 it('preserves a complete public static JD when a host is outside the optional render allowlist',async()=>{
  vi.stubGlobal('fetch',vi.fn(()=>new Response('<main><h1>Python Engineer Intern</h1><h2>Required skills</h2><p>'+description+'</p></main>')));
  hydrate.mockResolvedValue(null);const job=await verifyDiscoveryDetail(env,candidate);expect(job?.description).toContain(description);expect(job).toMatchObject({provenance:{kind:'page_text'}});
 });

 it('keeps job facts stable across rendering timing/usage changes',async()=>{
  const first=await verifyDiscoveryDetail(env,candidate);
  hydrate.mockResolvedValueOnce(new Response(html(posting),{headers:{'X-HireFlow-Source-URL':url,'X-HireFlow-Dynamic-Method':'hydrated_json_ld','X-HireFlow-Fetched-At':'2026-10-27T10:00:00Z','X-HireFlow-Rendered-D1-Calls':'10'}}));
  const second=await verifyDiscoveryDetail(env,candidate);expect(second).toEqual(first);expect(first).not.toHaveProperty('provenance.source_read_at');expect(first).not.toHaveProperty('provenance.rendering');
 });

});
