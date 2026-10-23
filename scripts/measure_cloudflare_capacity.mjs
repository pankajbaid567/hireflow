/** Bounded GET-only wall-time sampling. No profiles, searches or submissions.
 * node scripts/measure_cloudflare_capacity.mjs --base http://127.0.0.1:8787 --requests 30 --concurrency 5 --output /tmp/hireflow-capacity.json
 * Add --platform-metrics to query the fixed project's Cloudflare GraphQL data.
 * Credentials come from the environment or Wrangler's standard local config,
 * never command arguments or output. Platform failures remain explicit.
 */
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const args=process.argv.slice(2),option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1];};
const base=new URL(option('--base','http://127.0.0.1:8787'));
if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash)throw new Error('Use an HTTP(S) base URL without credentials or query parameters.');
if(base.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(base.hostname))throw new Error('Use HTTPS for remote sampling.');
const path=option('--path','/health');if(!/^\/(?:health|session|operations\/\d+)$/.test(path))throw new Error('Only GET /health, /session and /operations/{id} can be sampled.');
const sinceOption=option('--since',null);
if(sinceOption!==null&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(sinceOption)||!Number.isFinite(Date.parse(sinceOption))||new Date(sinceOption).toISOString().slice(0,19)!==sinceOption.slice(0,19)||Date.parse(sinceOption)>Date.now()))throw new Error('--since must be a past UTC ISO timestamp, for example 2026-10-23T03:00:00.000Z.');
const total=Math.floor(Math.max(1,Math.min(100,Number(option('--requests','30'))||30))),concurrency=Math.floor(Math.max(1,Math.min(10,Number(option('--concurrency','5'))||5)));
const target=new URL(`${base.pathname.replace(/\/$/,'')}${path}`,base.origin),samples=[],errors={};let next=0;
const started=Date.now(),deadline=started+60000;
const percentile=(values,fraction)=>values.length?values[Math.max(0,Math.ceil(values.length*fraction)-1)]:null;
await Promise.all(Array.from({length:concurrency},async()=>{
 for(;;){const index=next++;if(index>=total||Date.now()>=deadline)return;const before=performance.now();
  try{const response=await fetch(target,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(Math.min(8000,deadline-Date.now())),headers:process.env.HIREFLOW_SESSION?{Cookie:process.env.HIREFLOW_SESSION}:{}});await response.body?.cancel();samples.push({latency_ms:performance.now()-before,status:response.status});if(!response.ok)errors[`http_${response.status}`]=(errors[`http_${response.status}`]||0)+1;}
  catch(error){const kind=error?.name==='TimeoutError'?'timeout':'network';errors[kind]=(errors[kind]||0)+1;samples.push({latency_ms:performance.now()-before,status:null});}
 }
}));
const values=samples.map(value=>value.latency_ms).sort((a,b)=>a-b);
const result={created_at:new Date().toISOString(),target:target.origin+target.pathname,requested:total,completed:samples.length,concurrency,elapsed_ms:Date.now()-started,wall_time_ms:{p50:percentile(values,.5),p95:percentile(values,.95),p99:percentile(values,.99)},errors,platform_metrics:{state:'not_requested',cpu_time:null,memory:null},note:'Client wall time includes routing and network waits. It does not measure Worker CPU time, isolate memory or maximum sustainable capacity.'};
if(args.includes('--platform-metrics')){
 try{
  let token=process.env.CLOUDFLARE_API_TOKEN;
  if(!token){
    const directory=fileURLToPath(new URL('../cloudflare/',import.meta.url));
    const cli=fileURLToPath(new URL('../cloudflare/node_modules/wrangler/bin/wrangler.js',import.meta.url));
    if(existsSync(cli))try{const auth=spawnSync(process.execPath,[cli,'auth','token','--json'],{cwd:directory,encoding:'utf8',timeout:25000,stdio:['ignore','pipe','pipe']});const credentials=JSON.parse(auth.stdout);token=credentials.token||credentials.api_token||credentials.oauth_token;}catch{/* Fall back to an existing local token without printing credential output. */}
  }
  if(!token){for(const file of [`${homedir()}/Library/Preferences/.wrangler/config/default.toml`,`${homedir()}/.wrangler/config/default.toml`])if(existsSync(file)){const match=readFileSync(file,'utf8').match(/^oauth_token\s*=\s*"([^"]+)"/m);if(match){token=match[1];break;}}}
  if(!token)throw new Error('credentials_unavailable');
  const config=JSON.parse(readFileSync(fileURLToPath(new URL('../cloudflare/wrangler.jsonc',import.meta.url)),'utf8'));
  const metricsEnd=Date.now(),requestedStart=sinceOption?Date.parse(sinceOption):metricsEnd-3600000;
  const metricsStart=Math.max(metricsEnd-86400000,requestedStart),windowStart=new Date(metricsStart).toISOString(),windowEnd=new Date(metricsEnd).toISOString();
  const query='query Metrics($accountTag:string,$start:string,$end:string,$script:string){viewer{accounts(filter:{accountTag:$accountTag}){workersInvocationsAdaptive(limit:10,filter:{scriptName:$script,datetime_geq:$start,datetime_leq:$end}){sum{requests errors}quantiles{cpuTimeP50 cpuTimeP95 cpuTimeP99 memoryUsageBytesP50 memoryUsageBytesP95 memoryUsageBytesP99}}}}}';
  const response=await fetch('https://api.cloudflare.com/client/v4/graphql',{method:'POST',redirect:'manual',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query,variables:{accountTag:config.account_id,start:windowStart,end:windowEnd,script:config.name}})});
  const data=await response.json();
  if(!response.ok||data.errors?.length){result.platform_metrics={state:'unavailable',reason:'The configured credential could not read this Workers analytics dataset.',http_status:response.status,cpu_time:null,memory:null};}
  else{const rows=data.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];result.platform_metrics={state:rows.length?'available':'no_samples',window_start:windowStart,window_end:windowEnd,window_clamped:metricsStart!==requestedStart,scope:sinceOption?'since_requested_timestamp':'mixed_last_hour',source:'Cloudflare GraphQL workersInvocationsAdaptive',cpu_time:rows.map(row=>({cpuTimeP50:row.quantiles?.cpuTimeP50,cpuTimeP95:row.quantiles?.cpuTimeP95,cpuTimeP99:row.quantiles?.cpuTimeP99})),cpu_unit:'microseconds',cpu_time_ms:rows.map(row=>({p50:typeof row.quantiles?.cpuTimeP50==='number'?row.quantiles.cpuTimeP50/1000:null,p95:typeof row.quantiles?.cpuTimeP95==='number'?row.quantiles.cpuTimeP95/1000:null,p99:typeof row.quantiles?.cpuTimeP99==='number'?row.quantiles.cpuTimeP99/1000:null})),invocations:rows.map(row=>({requests:row.sum?.requests,errors:row.sum?.errors})),memory:rows.map(row=>({p50:row.quantiles?.memoryUsageBytesP50??null,p95:row.quantiles?.memoryUsageBytesP95??null,p99:row.quantiles?.memoryUsageBytesP99??null})),memory_unit:'bytes',scope_note:sinceOption?'Window starts at the supplied timestamp (maximum 24 hours). Confirm deployment completion and analytics ingestion before associating it with a release.':'Mixed whole-Worker metrics for the last hour; not isolated to this load run or an unpublished/new release.'};}
 }catch{result.platform_metrics={state:'unavailable',reason:'Platform analytics could not be read with the available local configuration.',cpu_time:null,memory:null};}
}
const output=option('--output',null);if(output)writeFileSync(output,JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result,null,2));
