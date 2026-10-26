/** Opt-in native Gmail TLS/EHLO compatibility probe, without authentication.
 * One private Queue invocation reuses Nodemailer and the production fixed socket.
 * No auth credentials, MAIL, RCPT or DATA; cleans its own Worker/Queue/KV/guard. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {mkdirSync,chmodSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
assert.ok(process.argv.includes('--run-live'),'Pass --run-live for the reviewed credential-free Gmail connectivity check.');
assert.ok(Number(process.versions.node.split('.')[0])>=22,'Use the project Node 22+ runtime.');
const root=fileURLToPath(new URL('../',import.meta.url)),project=root+'cloudflare/',require=createRequire(new URL('../cloudflare/package.json',import.meta.url));
const {buildSync}=require('esbuild');
const config=JSON.parse(readFileSync(project+'wrangler.jsonc','utf8')),pkg=JSON.parse(readFileSync(project+'package.json','utf8'));
assert.equal(pkg.devDependencies.wrangler,'4.151.3','Use the reviewed, pinned Wrangler version.');
assert.equal(config.name,'hireflow-api');assert.equal(config.account_id,'e644f1ced37b126db54d62bf6afd4d1a');
const database=config.d1_databases.find(value=>value.binding==='DB'),storage=config.kv_namespaces.find(value=>value.binding==='FILES_KV');
assert.equal(database?.database_id,'e4664667-cedb-4f84-9da6-32610a77c127');assert.equal(storage?.id,'b2c25a76089c4c11aacf1d0fef9b1b51');
const targetHost='smtp.gmail.com';
const id=randomUUID(),short=id.replaceAll('-','').slice(0,12),name='p3-gmail-qa-'+short,queue=name,directory='/tmp/hireflow-gmail-connection-live/'+short;
const key='qa/p3-gmail/'+id+'/result',guard='qa-gmail-probe:'+id,qaAccess=randomBytes(32).toString('base64url');
assert.match(name,/^p3-gmail-qa-[a-f0-9]{12}$/);
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync('/tmp/hireflow-gmail-connection-live',0o700);
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const proof={state:'running',stage:'preflight',source_commit:sourceCommit,started_at:new Date().toISOString(),smtp_host:targetHost,worker:name,queue,paid_plan_changes:0,employer_submissions:0,emails:0,model_requests:0,search_requests:0,quota_resets:0,cleanup:{}};
let apiToken=process.env.CLOUDFLARE_API_TOKEN||'',queueId,workerCreated=false,queueCreated=false,posted=false,origin,terminal;
const save=stage=>{if(stage)proof.stage=stage;writeFileSync(directory+'/proof.json',JSON.stringify(proof,null,2)+'\n',{mode:0o600});};
const redact=text=>[qaAccess,apiToken].filter(Boolean).reduce((result,value)=>result.replaceAll(value,'[REDACTED]'),String(text));
function cli(args,{input='',sensitive=false,timeout=90000}={}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[project+'node_modules/wrangler/bin/wrangler.js',...args],{cwd:project,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'},stdio:['pipe','pipe','pipe']});
    let output='',errors='',done=false;
    const timer=setTimeout(()=>{child.kill('SIGTERM');},timeout);
    child.stdout.on('data',bytes=>{output+=bytes;if(output.length>8*1024*1024)child.kill('SIGTERM');});child.stderr.on('data',bytes=>{errors+=bytes;if(errors.length>1024*1024)child.kill('SIGTERM');});
    child.on('error',()=>{clearTimeout(timer);if(!done){done=true;reject(new Error('The pinned Wrangler process could not start.'));}});
    child.on('close',code=>{
      clearTimeout(timer);if(done)return;done=true;
      if(!sensitive)writeFileSync(directory+'/wrangler.log',redact(`\n${JSON.stringify(args)}\n${output}\n${errors}`),{mode:0o600,flag:'a'});
      if(code!==0)reject(new Error(`Wrangler ${args.slice(0,2).join(' ')} failed (exit ${code}); redacted diagnostic stays private.`));else resolve(output);
    });child.stdin.end(input);
  });
}
async function refreshOperatorToken(){
  if(process.env.CLOUDFLARE_API_TOKEN)return;
  const credentials=JSON.parse(await cli(['auth','token','--json'],{sensitive:true}));
  apiToken=credentials.token||credentials.api_token||credentials.oauth_token||'';assert.ok(apiToken,'Cloudflare operator authentication is unavailable.');
}
async function api(method,path,body,allowMissing=false){
  for(let attempt=0;attempt<2;attempt++){
    const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+apiToken,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(20000)});
    if(allowMissing&&response.status===404){await response.body?.cancel();return {missing:true,status:404};}
    if(attempt===0&&[401,403].includes(response.status)&&!process.env.CLOUDFLARE_API_TOKEN){await response.body?.cancel();await refreshOperatorToken();continue;}
    const data=await response.json().catch(()=>null);
    if(!response.ok||data?.success===false)throw Object.assign(new Error(`Cloudflare ${method} request failed with HTTP ${response.status}.`),{http_status:response.status,error_codes:data?.errors?.map(value=>value.code)||[]});
    return data;
  }
}
async function query(sql,params=[]){return (await api('POST',`/accounts/${config.account_id}/d1/database/${database.database_id}/query`,{sql,params})).result;}
async function endpoint(path,{method='GET',authorized=true}={}){
  return fetch(origin+path,{method,headers:authorized?{Authorization:'Bearer '+qaAccess}:{},redirect:'manual',signal:AbortSignal.timeout(15000)});
}
async function boundedBody(response,limit=2000){
  const reader=response.body?.getReader();if(!reader)return '';
  let length=0,parts=[];try{for(;;){const next=await reader.read();if(next.done)break;const part=next.value.subarray(0,limit-length);parts.push(part);length+=part.length;if(part.length!==next.value.length||length>=limit){await reader.cancel();break;}}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return new TextDecoder().decode(bytes);
}
async function waitForState(path,state,{authorized=true,milliseconds=20000}={}){
  const until=Date.now()+milliseconds;let last;
  while(Date.now()<until){
    const response=await endpoint(path,{authorized}),body=await boundedBody(response);let value;try{value=JSON.parse(body);}catch{}
    last={status:response.status,body:redact(body)};
    if(value?.state===state)return {status:response.status,value};await pause(1500);
  }
  throw new Error(`Private probe readiness failed: ${JSON.stringify(last).slice(0,500)}`);
}
async function waitForResult(milliseconds){
  const until=Date.now()+milliseconds;
  while(Date.now()<until){
    const response=await endpoint('/result');
    if(response.status===200){const value=await response.json();if(['passed','failed'].includes(value.state))return value;}
    else{await response.body?.cancel();if(![202,404,503].includes(response.status))throw new Error(`Private probe polling returned HTTP ${response.status}.`);}
    await pause(3000);
  }
  throw new Error('The one-shot Queue probe did not publish a result within its bounded observation.');
}
async function acknowledgedWithoutNativeClaim(){
  if(!queueId)return false;
  try{
    const guards=await query('SELECT attempts FROM login_attempts WHERE key=?',[guard]);
    const metrics=await api('GET',`/accounts/${config.account_id}/queues/${queueId}/metrics`);
    const queryText='query($accountTag:string!,$queueId:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$accountTag}){queueMessageOperationsAdaptiveGroups(limit:100,filter:{queueId:$queueId,datetime_geq:$start,datetime_leq:$end}){count dimensions{actionType outcome consumerType}}}}}';
    const operations=await api('POST','/graphql',{query:queryText,variables:{accountTag:config.account_id,queueId,start:proof.started_at,end:new Date().toISOString()}});
    const groups=operations.data?.viewer?.accounts?.[0]?.queueMessageOperationsAdaptiveGroups||[];
    const count=(action,outcome)=>groups.filter(item=>item.dimensions.actionType===action&&(!outcome||item.dimensions.outcome===outcome)).reduce((sum,item)=>sum+item.count,0);
    proof.native_task_observation={checked_at:new Date().toISOString(),guard_rows:guards[0]?.results?.length||0,backlog_count:metrics.result?.backlog_count,writes:count('WriteMessage'),reads:count('ReadMessage'),successful_deletes:count('DeleteMessage','success'),metrics_are_best_effort:true};
    save();
    // Require the exact Queue's acknowledged single task as well as empty
    // backlog. A best-effort zero backlog alone cannot prove execution/ack.
    return !proof.native_task_observation.guard_rows&&proof.native_task_observation.backlog_count===0&&proof.native_task_observation.writes===1&&proof.native_task_observation.reads>=1&&proof.native_task_observation.successful_deletes===1;
  }catch(error){proof.native_task_observation={unavailable:true,http_status:error?.http_status};save();return false;}
}
const source=`
const run=${JSON.stringify(id)};
const json=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'private, no-store'}});
async function permitted(request,env){
 if(!env.QA_ACCESS_KEY)return false;
 const encoder=new TextEncoder(),expected=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode('Bearer '+env.QA_ACCESS_KEY))),actual=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(request.headers.get('Authorization')||'')));
 let difference=0;for(let i=0;i<32;i++)difference|=expected[i]^actual[i];return difference===0;
}
export default{
 async fetch(request,env){
  if(!env.QA_ACCESS_KEY)return json({state:'not_configured'},503);
  if(!await permitted(request,env))return json({state:'unauthorized'},401);
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/ready')return json({state:'ready',run});
  if(request.method==='GET'&&path==='/result'){const result=await env.FILES_KV.get(env.QA_RESULT_KEY,'json');return result?json(result):json({state:'waiting'},202);}
  if(request.method==='POST'&&path==='/probe'){
   // Caller body is ignored; no message, sender, credentials or host can be supplied.
   await env.PROBE_QUEUE.send({kind:'gmail_connection_probe',run});return json({state:'queued'},202);
  }
  return json({state:'not_found'},404);
 },
 async queue(batch,env){
  for(const message of batch.messages){
   if(!env.QA_ACCESS_KEY||message.body?.kind!=='gmail_connection_probe'||message.body?.run!==run){message.ack();continue;}
   let result;
   try{
    const claimed=await env.DB.prepare('INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO NOTHING RETURNING key').bind(env.QA_GUARD_KEY,Date.now()).first();
    if(!claimed){message.ack();continue;}
    // Nodemailer initializes only within Queue CPU context. This helper has no
    // Gmail credentials or message input and cannot perform an SMTP submission.
    const {probeGmailConnection}=await import(${JSON.stringify(root+'cloudflare/src/gmail_transport.ts')});
    const connection=await probeGmailConnection();
    result={state:connection.state==='verified'?'passed':'failed',runtime:'native Cloudflare Queue + Nodemailer + fixed node:tls socket',checked_at:new Date().toISOString(),connection,emails:0,authenticated:false};
   }catch{result={state:'failed',checked_at:new Date().toISOString(),reason:'The credential-free native connection probe failed.',emails:0,authenticated:false};}
   try{await env.FILES_KV.put(env.QA_RESULT_KEY,JSON.stringify(result),{expirationTtl:600});}finally{message.ack();}
  }
 }
};`;
try{
  save('preflight');
  // Current documentation: Workers Admin/legacy Scripts Write for creating and
  // deleting this QA Worker, Queues Write, D1 Read/Write and KV Read/Write.
  const who=await cli(['whoami'],{sensitive:true});assert.ok(who.includes(config.account_id),'The authenticated account does not match this project.');
  if(!apiToken){const credentials=JSON.parse(await cli(['auth','token','--json'],{sensitive:true}));apiToken=credentials.token||credentials.api_token||credentials.oauth_token||'';}
  assert.ok(apiToken,'Cloudflare operator authentication is unavailable.');proof.authenticated_account_verified=true;
  const existingWorker=await api('GET',`/accounts/${config.account_id}/workers/scripts/${name}/script-settings`,undefined,true);assert.equal(existingWorker.missing,true,'Refusing to reuse an existing QA-named Worker.');
  const queues=await api('GET',`/accounts/${config.account_id}/queues?name=${queue}`);assert.ok(Array.isArray(queues.result));assert.ok(!queues.result.some(item=>item.queue_name===queue),'Refusing to reuse an existing QA-named queue.');
  proof.smtp_authentication=false;proof.smtp_messages=0;proof.gmail_source_sha256=createHash('sha256').update(readFileSync(project+'src/gmail_transport.ts')).digest('hex');proof.nodemailer_version=pkg.dependencies.nodemailer;
  const bundle=buildSync({stdin:{contents:source,resolveDir:project,loader:'ts'},bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;
  assert.ok(!bundle.includes(qaAccess)&&!bundle.includes(apiToken),'Credentials must not appear in QA source.');writeFileSync(directory+'/probe.js',bundle,{mode:0o600});proof.qa_bundle_sha256=createHash('sha256').update(bundle).digest('hex');
  const qaConfig={name,account_id:config.account_id,main:directory+'/probe.js',compatibility_date:config.compatibility_date,compatibility_flags:config.compatibility_flags,workers_dev:true,observability:{enabled:false},d1_databases:[{binding:'DB',database_name:database.database_name,database_id:database.database_id}],kv_namespaces:[{binding:'FILES_KV',id:storage.id}],queues:{producers:[{binding:'PROBE_QUEUE',queue}],consumers:[{queue,max_batch_size:1,max_batch_timeout:1,max_retries:0,max_concurrency:1}]},vars:{QA_RESULT_KEY:key,QA_GUARD_KEY:guard}};
  const configPath=directory+'/wrangler.jsonc';writeFileSync(configPath,JSON.stringify(qaConfig,null,2)+'\n',{mode:0o600});
  save('create_qa_resources');queueCreated=true;await cli(['queues','create',queue,'--message-retention-period-secs','600','--config',configPath]);
  const queueInfo=await api('GET',`/accounts/${config.account_id}/queues?name=${queue}`);const own=queueInfo.result.find(item=>item.queue_name===queue);assert.match(own?.queue_id||'',/^[a-f0-9]{32}$/);queueId=own.queue_id;
  // The first and only source version already has its secret. Publishing an
  // unconfigured version and updating it later can let a stale Queue consumer
  // acknowledge the one-shot task before claiming the native execution guard.
  const secretPath=directory+'/qa-secrets.json';writeFileSync(secretPath,JSON.stringify({QA_ACCESS_KEY:qaAccess})+'\n',{mode:0o600});
  workerCreated=true;let deployment;
  try{deployment=await cli(['deploy','--config',configPath,'--secrets-file',secretPath]);}finally{rmSync(secretPath,{force:true});}
  proof.qa_initial_source_version=deployment.match(/Current Version ID:\s*([a-f0-9-]{36})/)?.[1]||null;proof.qa_secret_bound_on_initial_deploy=true;proof.secretless_initial_version_created=false;
  origin=deployment.match(new RegExp('https://'+name+'\\.[a-zA-Z0-9.-]+\\.workers\\.dev'))?.[0];assert.ok(origin,'The new QA deployment URL was not returned.');proof.probe_origin=origin;save('verify_initial_lock');
  const anonymous=await waitForState('/result','unauthorized',{authorized:false});assert.equal(anonymous.status,401);proof.anonymous_after_secret_http=401;proof.anonymous_after_secret_json='unauthorized';
  const ready=await waitForState('/ready','ready');assert.equal(ready.status,200);assert.equal(ready.value.run,id);proof.authenticated_ready_http=200;
  save('one_shot_native_smtp_probe');posted=true;const enqueued=await endpoint('/probe',{method:'POST'});const enqueueBody=await boundedBody(enqueued);proof.enqueue_response={status:enqueued.status,body:redact(enqueueBody)};save();assert.equal(enqueued.status,202);
  terminal=await waitForResult(180000);writeFileSync(directory+'/native-result.json',JSON.stringify(terminal,null,2)+'\n',{mode:0o600});proof.result=terminal;
  assert.equal(terminal.state,'passed',terminal.reason||'Native Gmail connection verification failed.');assert.equal(terminal.connection.state,'verified');assert.equal(terminal.connection.authenticated,false);assert.equal(terminal.connection.email_sent,false);
  proof.state='passed';save('probe_passed');
}catch(error){proof.state='failed';proof.error=redact(error.message).slice(0,400);process.exitCode=1;save('failed');}
finally{
  save('cleanup');
  const failures=[];proof.cleanup.errors=[];const failure=(operation,error)=>{failures.push(operation);proof.cleanup.errors.push({operation,message:redact(error?.message||'Cleanup operation failed.').slice(0,300),http_status:error?.http_status,error_codes:error?.error_codes});};
  if(apiToken&&proof.authenticated_account_verified)try{await refreshOperatorToken();}catch(error){failure('auth_refresh',error);}
  // An uncertain enqueue POST is never repeated. Observe its possible one-shot task
  // before removing the result, rather than leaving a late publisher behind.
  if(posted&&!terminal&&origin){
    if(await acknowledgedWithoutNativeClaim())proof.no_native_execution_observed=true;
    else try{terminal=await waitForResult(180000);proof.terminal_after_error=terminal.state;}catch{/* Failure remains a failure; no re-enqueue or quota reset. */}
  }
  if(apiToken&&proof.authenticated_account_verified){
    try{await api('DELETE',`/accounts/${config.account_id}/storage/kv/namespaces/${storage.id}/values/${encodeURIComponent(key)}`,undefined,true);proof.cleanup.private_result_deleted=true;}catch(error){failure('private_result_delete',error);}
  }
  if(queueCreated&&queueId&&apiToken&&proof.authenticated_account_verified)try{
    const metadata=await api('GET',`/accounts/${config.account_id}/queues/${queueId}`);assert.equal(metadata.result.queue_name,queue);
    const consumers=metadata.result.consumers||[];assert.ok(consumers.length<=1,'Refusing unexpected consumer topology on the new QA queue.');
    for(const consumer of consumers){assert.match(consumer.consumer_id||'',/^[a-f0-9]{32}$/);await api('DELETE',`/accounts/${config.account_id}/queues/${queueId}/consumers/${consumer.consumer_id}`);}
    proof.cleanup.exact_qa_consumers_detached=true;
  }catch(error){failure('consumer_detach',error);}
  if(workerCreated)try{await cli(['delete',name,'--force','--config',directory+'/wrangler.jsonc']);proof.cleanup.worker_deleted=true;}catch(error){failure('worker_delete',error);}
  if(queueCreated)try{await cli(['queues','delete',queue,'--config',directory+'/wrangler.jsonc']);proof.cleanup.queue_deleted=true;}catch(error){failure('queue_delete',error);}
  if(apiToken&&proof.authenticated_account_verified){
    try{await query('DELETE FROM login_attempts WHERE key=?',[guard]);const rows=await query('SELECT COUNT(*) AS n FROM login_attempts WHERE key=?',[guard]);assert.equal(rows[0].results[0].n,0);proof.cleanup.exact_qa_guard_absent=true;}catch(error){failure('qa_guard_delete_verify',error);}
    if(workerCreated)try{const state=await api('GET',`/accounts/${config.account_id}/workers/scripts/${name}/script-settings`,undefined,true);assert.equal(state.missing,true);proof.cleanup.worker_absent=true;}catch(error){failure('worker_absence_verify',error);}
    if(queueId)try{const state=await api('GET',`/accounts/${config.account_id}/queues/${queueId}`,undefined,true);assert.equal(state.missing,true);proof.cleanup.queue_absent=true;}catch(error){failure('queue_absence_verify',error);}
    try{const state=await api('GET',`/accounts/${config.account_id}/storage/kv/namespaces/${storage.id}/values/${encodeURIComponent(key)}`,undefined,true);assert.equal(state.missing,true);proof.cleanup.private_result_absent=true;}catch(error){failure('private_result_absence_verify',error);}
  }
  proof.cleanup.failures=failures;if(failures.length){proof.state='failed';process.exitCode=1;}
  proof.finished_at=new Date().toISOString();save('complete');
  console.log(JSON.stringify({state:proof.state,proof:directory+'/proof.json',cleanup_failures:failures,error:proof.error}));
}
