#!/usr/bin/env node
/** Explicit local alternative: real source verification, persistent local D1,
 * no deployed browser, paid storage, submissions or email. */
import {readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,chmodSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildSync} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
const args=process.argv.slice(2),option=(name,fallback)=>{const at=args.indexOf(name);return at<0?fallback:args[at+1];};
if(args.includes('--help')){console.log('node --env-file=../.env scripts/discover_local.mjs --profile /private/profile.json --directory /private/discovery --target 100 [--resume]\nRuns the actual bounded discovery engine locally. Uses real search credits; source restrictions and provider quotas still apply. Output is private full-JD JSON, never employer submissions.');process.exit(0);}
const offline=args.includes('--offline-fixture');
if(!offline&&!process.env.TAVILY_API_KEY&&!process.env.SERPAPI_API_KEY)throw new Error('Set TAVILY_API_KEY or SERPAPI_API_KEY privately.');
const directory=resolve(option('--directory','/tmp/hireflow-local-discovery')),root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),target=Number(option('--target','100'));
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
const checkpointPath=resolve(directory,'checkpoint.json'),resultPath=resolve(directory,'verified-jobs.json');
if(existsSync(checkpointPath)&&!args.includes('--resume'))throw new Error('A checkpoint exists. Use --resume or a new directory.');
const bundle=buildSync({stdin:{contents:`import worker from './src/index';import {recoverDiscoveryCycles} from './src/discovery_cycles';export default{async fetch(request,env,ctx){if(new URL(request.url).pathname==='/__local/tick'){await recoverDiscoveryCycles(env);const task=await request.json();const message={id:crypto.randomUUID(),timestamp:new Date(),body:task,attempts:1,ack(){},retry(){}};await worker.queue({queue:'local-discovery',messages:[message],ackAll(){},retryAll(){},metadata:{metrics:{backlogCount:0,backlogBytes:0}}},env);return Response.json({ok:true});}return worker.fetch(request,env,ctx);}}`,resolveDir:root,loader:'ts'},bundle:true,platform:'browser',format:'esm',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],resourcePersistencePath:resolve(directory,'state'),r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'local-discovery'},bindings:{ACCESS_CODE:'local-discovery-private-operator-credential',TAVILY_API_KEY:offline?'offline-fixture':process.env.TAVILY_API_KEY||'',SERPAPI_API_KEY:process.env.SERPAPI_API_KEY||'',BROWSER_ENABLED:'false',PLAN_WORK_IN_QUEUE:'true',SEMANTIC_MATCHING_ENABLED:'false',DISCOVERY_DAILY_SEARCH_BUDGET:'40',DISCOVERY_DAILY_DETAIL_BUDGET:'800'},...(offline?{outboundService:async request=>{
 const host=new URL(request.url).hostname;
 if(host==='api.tavily.com'){const body=await request.json();return Response.json({results:body.include_domains?.includes('boards.greenhouse.io')?[{title:'Python Engineer Intern',url:'https://boards.greenhouse.io/offlinefixture/jobs/123',content:'Synthetic search snippet.'}]:[]});}
 if(host==='boards-api.greenhouse.io')return Response.json({title:'Python Engineer Intern',content:'Synthetic supervised Python software engineering internship. Build APIs and tests with mentors. '.repeat(6),location:{name:'India'},absolute_url:'https://boards.greenhouse.io/offlinefixture/jobs/123'});
 throw new Error('Offline fixture rejects all other network access');
 }}:{})}));
let checkpoint=existsSync(checkpointPath)?JSON.parse(readFileSync(checkpointPath,'utf8')):null;
async function api(path,method='GET',body){const r=await mf.dispatchFetch('https://local-discovery.example'+path,{method,headers:{'Content-Type':'application/json',Cookie:checkpoint?.cookie||'','X-HireFlow-Access-Code':'local-discovery-private-operator-credential'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Local request failed');return{data,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
function save(){writeFileSync(checkpointPath,JSON.stringify(checkpoint,null,2),{mode:0o600});}
try{
 const db=await mf.getD1Database('DB');
 await db.prepare('CREATE TABLE IF NOT EXISTS local_schema(name TEXT PRIMARY KEY)').run();
 for(const file of readdirSync(resolve(root,'migrations')).filter(name=>/^\d+.*\.sql$/.test(name)).sort()){
  if(await db.prepare('SELECT name FROM local_schema WHERE name=?').bind(file).first())continue;
  await db.batch([...unstable_splitSqlQuery(readFileSync(resolve(root,'migrations',file),'utf8')).map(sql=>db.prepare(sql)),db.prepare('INSERT INTO local_schema(name) VALUES(?)').bind(file)]);
 }
 if(!checkpoint){const profilePath=option('--profile');if(!profilePath)throw new Error('Supply --profile with your local profile JSON.');const profile=JSON.parse(readFileSync(resolve(profilePath),'utf8'));const created=await api('/profile','POST',profile);checkpoint={user_id:created.data.id,cookie:created.cookie,offline_fixture:offline,created_at:new Date().toISOString()};save();const started=await api(`/jobs/${checkpoint.user_id}/discovery-cycles`,'POST',{target,max_search_calls:Math.min(30,Math.max(6,Math.ceil(target/4))),max_detail_checks:Math.min(400,target*3)});checkpoint.cycle_id=started.data.id;save();}
 if(Boolean(checkpoint.offline_fixture)!==offline)throw new Error('Do not mix offline fixtures and real discovery in one checkpoint.');
 if(!checkpoint.cycle_id){const started=await api(`/jobs/${checkpoint.user_id}/discovery-cycles`,'POST',{target});checkpoint.cycle_id=started.data.id;save();}
 if(args.includes('--resume')){const current=(await api(`/jobs/${checkpoint.user_id}/discovery-cycles/${checkpoint.cycle_id}`)).data;if(['paused','cancelled','failed'].includes(current.state))try{await api(`/jobs/${checkpoint.user_id}/discovery-cycles/${checkpoint.cycle_id}/resume`,'POST',{});}catch(error){console.log('Checkpoint remains stopped: '+error.message);}}
 let last='';
 for(;;){const {data}=await api(`/jobs/${checkpoint.user_id}/discovery-cycles/${checkpoint.cycle_id}`);const line=`${data.state}: ${data.verified_count}/${data.target_count} verified; ${data.search_calls} searches; ${data.detail_checks} detail checks`;if(line!==last){console.log(line);last=line;}
  if(!['queued','running'].includes(data.state)){const rows=await db.prepare("SELECT j.*,c.evidence_json FROM discovery_candidates c JOIN jobs j ON j.id=c.job_id WHERE c.cycle_id=? AND c.state='verified' ORDER BY j.id").bind(checkpoint.cycle_id).all();writeFileSync(resultPath,JSON.stringify({cycle:data,listings:rows.results},null,2),{mode:0o600});console.log(`Saved ${rows.results.length} verified full JDs to ${resultPath}. ${data.detail||''}`);break;}
  // Message delivery through the actual Worker Queue entrypoint. Producer sends
  // are durable hints; this explicit local loop does not expose a public server.
  await api('/__local/tick','POST',{kind:'discovery_cycle',cycle_id:checkpoint.cycle_id});
  await new Promise(resolve=>setTimeout(resolve,1100));
 }
}finally{await mf.dispose();}
