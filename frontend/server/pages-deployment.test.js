// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {verifyPublishedAPI} from '../../scripts/deploy_cloudflare_pages.mjs';
const good=()=>Response.json({status:'ok',runtime:'cloudflare-workers'});
describe('published Pages proxy smoke',()=>{
 it('rejects an HTTP 200 SPA fallback before attempting any profile request',async()=>{
  const fetcher=vi.fn(()=>new Response('<html>HireFlow SPA</html>',{headers:{'Content-Type':'text/html'}}));await expect(verifyPublishedAPI('https://site.example',fetcher)).rejects.toThrow('static SPA fallback');expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it.each([405,401])('rejects a proxy which does not forward invalid profile validation (HTTP %i)',async status=>{
  const fetcher=vi.fn().mockResolvedValueOnce(good()).mockResolvedValueOnce(Response.json({detail:'Synthetic failure'},{status}));await expect(verifyPublishedAPI('https://site.example',fetcher)).rejects.toThrow('HTTP 422');
 });
 it('checks actual backend JSON and validation without submitting a real profile',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(good()).mockResolvedValueOnce(Response.json({detail:'Name and email required.'},{status:422}));await expect(verifyPublishedAPI('https://site.example',fetcher)).resolves.toMatchObject({health_json:true,invalid_profile_status:422,real_profiles_created:0});expect(fetcher.mock.calls[1][1]).toMatchObject({method:'POST',body:'{}'});
 });
 it('rejects malformed or wrong-runtime health JSON',async()=>{
  await expect(verifyPublishedAPI('https://site.example',()=>Promise.resolve(Response.json({status:'ok',runtime:'unrelated'})))).rejects.toThrow();
  await expect(verifyPublishedAPI('https://site.example',()=>Promise.resolve(new Response('not JSON',{headers:{'Content-Type':'application/json'}})))).rejects.toThrow('valid JSON');
 });
});
