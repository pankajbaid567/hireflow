import { describe,expect,it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../../scripts/measure_cloudflare_capacity.mjs',import.meta.url));
function run(args:string[]){return new Promise<{code:number|null;stdout:string;stderr:string}>(resolve=>{const child=spawn(process.execPath,[script,...args],{env:{...process.env,HIREFLOW_SESSION:'',CLOUDFLARE_API_TOKEN:''}});let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);child.on('exit',code=>resolve({code,stdout,stderr}));});}
describe('repeatable bounded capacity sampler',()=>{
  it('performs GET health requests and reports actual wall-time percentiles without inventing CPU or memory',async()=>{
    let calls=0;const server=createServer((request,response)=>{expect(request.method).toBe('GET');expect(request.url).toBe('/health');calls++;response.setHeader('Content-Type','application/json');response.end('{"status":"ok"}');});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{const address=server.address() as {port:number};const result=await run(['--base',`http://127.0.0.1:${address.port}`,'--requests','12','--concurrency','3']);expect(result.code).toBe(0);const report=JSON.parse(result.stdout);expect(calls).toBe(12);expect(report).toMatchObject({completed:12,concurrency:3,errors:{},platform_metrics:{state:'not_requested',cpu_time:null,memory:null}});expect(report.wall_time_ms.p99).toBeGreaterThanOrEqual(report.wall_time_ms.p50);expect(report.note).toContain('does not measure Worker CPU');}
    finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('refuses endpoints that can generate resumes, search or submit applications',async()=>{
    const result=await run(['--path','/weekly-plan/1']);expect(result.code).not.toBe(0);expect(result.stderr).toContain('Only GET /health');
  });
  it.each(['not-a-date','2026-10-23','2999-01-01T00:00:00.000Z'])('rejects an invalid or future platform sampling timestamp %s',async since=>{
    const result=await run(['--since',since]);expect(result.code).not.toBe(0);expect(result.stderr).toContain('--since must be a past UTC ISO timestamp');
  });
});
