import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import { Miniflare,convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';
import { classifyProviderError,recordProviderOutcome,runModelDiagnostics,safeProviderHealth } from '../src/provider_health';
import { browserDailyBudgetSeconds,getOperationsStatus,newOperationContext,pruneOperations,recordOperation,submissionDelayMs } from '../src/telemetry';
import { generateText } from '../src/intelligence';
import { tailorResume } from '../src/resume_tailoring';
import type { Env } from '../src/types';
let mf:Miniflare,env:Env,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test")}}',compatibilityDate:'2026-10-21',d1Databases:['DB']}));
  db=await mf.getD1Database('DB');await applyTestMigrations(db);
  await db.prepare("INSERT INTO users(name,email,mode) VALUES('Synthetic One','one@example.com','internship'),('Synthetic Two','two@example.com','job')").run();
  env={DB:db,GROQ_API_KEY:'test-secret',GROQ_MODEL:'configured-groq',GEMINI_API_KEY:'gemini-secret',GEMINI_MODEL:'configured-gemini',GEMINI_FALLBACK_MODEL:'configured-fallback',BROWSER_ENABLED:'true',OPERATION_CONTEXT:newOperationContext(1)} as unknown as Env;
},30000);
afterEach(async()=>{vi.unstubAllGlobals();await mf?.dispose();},30000);
describe('safe provider degradation',()=>{
  it.each([[429,'rate_limited',true],[408,'timeout',true],[504,'timeout',true],[404,'model_unavailable',false],[401,'authentication',false],[400,'invalid_request',false],[503,'unavailable',true]] as const)('classifies HTTP %s without echoing private error data',async(status,kind,retryable)=>{
    const failure=classifyProviderError('groq',new Error('private-email@example.com gsk_do-not-log provider body'),{status,retryAfter:status===429?'900':null});
    expect(failure.kind).toBe(kind);expect(failure.retryable).toBe(retryable);expect(JSON.stringify(failure)).not.toMatch(/private-email|do-not-log|provider body/);if(status===429)expect(failure.retry_after_seconds).toBe(300);
  });
  it.each(['groq','gemini'] as const)('records a %s outage and keeps typed failure details safe',async provider=>{
    vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"error":"private-provider-body"}',{status:429})));
    const attempt=generateText({...env,LLM_PROVIDER:provider},'private resume facts');
    await expect(attempt).rejects.toMatchObject({provider_failure:{kind:'rate_limited',retryable:true}});
    const health=await safeProviderHealth(env);expect(health.find(row=>row.provider===provider&&row.role==='primary')).toMatchObject({state:'degraded',failure_kind:'rate_limited'});
    const stored=JSON.stringify((await db.prepare('SELECT * FROM operation_events').all()).results);expect(stored).not.toMatch(/private resume|private-provider|test-secret|gemini-secret/);
  });
  it('exposes a typed rate-limit warning in the factual resume fallback',async()=>{
    const result=await tailorResume(env,{skills:['Python'],projects:[{name:'Data Tools',description:'Built Python data checks for coursework.'}]},{title:'Python Intern',listing_type:'internship'},['Python'],{fetcher:vi.fn(async()=>new Response('{}',{status:429,headers:{'Retry-After':'30'}})) as typeof fetch});
    expect(result.metadata).toMatchObject({method:'deterministic',provider_failure:{kind:'rate_limited',retry_after_seconds:30}});expect(result.metadata.warnings.join(' ')).toContain('rate limited');expect(result.profile.summary).toContain('Built Python data checks');
  });
  it('distinguishes a transport outage from an invalid model selection',async()=>{
    const result=await tailorResume(env,{projects:[{name:'Data Tools',description:'Built Python data checks for coursework.'}]},{title:'Python Intern',listing_type:'internship'},[],{fetcher:vi.fn(async()=>{throw new Error('private transport message');}) as typeof fetch});
    expect(result.metadata.provider_failure?.kind).toBe('unavailable');expect(result.metadata.reason).toBe('provider_unavailable');expect(JSON.stringify(result.metadata)).not.toContain('private transport');
  });
});
describe('bounded opt-in diagnostics',()=>{
  it('only probes configured fixed model URLs with a synthetic prompt and enforces the durable cooldown',async()=>{
    const calls:string[]=[];
    const fetcher=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
      calls.push(String(input));expect(init!.redirect).toBe('manual');expect(String(init!.body)).not.toMatch(/one@example|Synthetic One|resume|test-secret|gemini-secret/);
      return String(input).includes('groq.com')?Response.json({choices:[{message:{content:'HireFlow ready'}}]}):Response.json({candidates:[{content:{parts:[{text:'HireFlow ready'}]}}]});
    });
    const result=await runModelDiagnostics(env,1,{fetcher:fetcher as typeof fetch});expect(result.checks).toHaveLength(3);expect(result.checks.every(row=>row.state==='healthy')).toBe(true);
    expect(calls).toEqual(expect.arrayContaining(['https://api.groq.com/openai/v1/chat/completions','https://generativelanguage.googleapis.com/v1beta/models/configured-gemini:generateContent','https://generativelanguage.googleapis.com/v1beta/models/configured-fallback:generateContent']));
    await expect(runModelDiagnostics(env,1,{fetcher:fetcher as typeof fetch})).rejects.toMatchObject({status:429});expect(calls).toHaveLength(3);
  });
  it('shows unavailable models and malformed responses individually without changing model configuration',async()=>{
    const fetcher=vi.fn(async(input:RequestInfo|URL)=>String(input).includes('groq.com')?new Response('private body',{status:404}):new Response('not json'));
    const result=await runModelDiagnostics(env,1,{fetcher:fetcher as typeof fetch});expect(result.checks[0].failure).toMatchObject({kind:'model_unavailable',retryable:false});expect(result.checks.slice(1).every(row=>row.failure?.kind==='malformed')).toBe(true);expect(JSON.stringify(result)).not.toContain('private body');expect(env.GEMINI_MODEL).toBe('configured-gemini');
  });
  it('bounds stalled providers under a common deadline without requiring the fetch implementation to cooperate',async()=>{
    const result=await runModelDiagnostics(env,1,{fetcher:vi.fn(()=>new Promise(()=>{})) as typeof fetch,timeoutMs:5});expect(result.checks).toHaveLength(3);expect(result.checks.every(row=>row.failure?.kind==='timeout')).toBe(true);
  });
  it('rejects an oversized response body and never follows a redirect',async()=>{
    const result=await runModelDiagnostics(env,1,{fetcher:vi.fn(async(input:RequestInfo|URL)=>String(input).includes('groq.com')?new Response('x'.repeat(33000)):new Response(null,{status:302,headers:{Location:'https://attacker.example'}})) as typeof fetch});
    expect(result.checks[0].failure?.kind).toBe('malformed');expect(result.checks.slice(1).every(row=>row.state==='degraded')).toBe(true);
  });
  it('does not call providers whose keys or models are unconfigured',async()=>{
    const fetcher=vi.fn();const result=await runModelDiagnostics({...env,GROQ_API_KEY:'placeholder',GEMINI_API_KEY:undefined},1,{fetcher});expect(result.checks).toHaveLength(0);expect(fetcher).not.toHaveBeenCalled();expect(result.providers.every(row=>row.state==='not_configured')).toBe(true);
  });
});
describe('durable owner-scoped operations and capacity',()=>{
  it('reports the shared semantic allowance without calling the embedding model',async()=>{
    const embedding=vi.fn(),day=new Date().toISOString().slice(0,10);
    await db.prepare('INSERT INTO semantic_usage(day,texts_reserved,characters_reserved) VALUES(?,7,12000)').bind(day).run();
    const status=await getOperationsStatus({...env,SEMANTIC_MATCHING_ENABLED:'true',SEMANTIC_DAILY_TEXT_BUDGET:'10',AI:{run:embedding} as any},1);
    expect(status.capacity).toMatchObject({semantic_matching_enabled:true,semantic_daily_text_budget:10,semantic_texts_reserved:7,semantic_texts_remaining:3,semantic_characters_reserved:12000,semantic_model:'@cf/baai/bge-small-en-v1.5:cls'});
    expect(embedding).not.toHaveBeenCalled();
    expect((await getOperationsStatus({...env,SEMANTIC_DAILY_TEXT_BUDGET:'99999'},1)).capacity.semantic_daily_text_budget).toBe(100);
  });
  it('fails an invalid semantic budget closed and explains the lexical fallback without spending browser allowance',async()=>{
    const status=await getOperationsStatus({...env,SEMANTIC_MATCHING_ENABLED:'true',SEMANTIC_DAILY_TEXT_BUDGET:'invalid'},1);
    expect(status.capacity).toMatchObject({semantic_daily_text_budget:0,semantic_texts_remaining:0,remaining_application_slots:9});
    expect(status.alerts.join(' ')).toContain('cached embeddings remain available');
    expect(status.alerts.join(' ')).toContain('embedding binding is configured');
    expect((await db.prepare('SELECT count(*) AS count FROM semantic_usage').first<any>())!.count).toBe(0);
  });
  it('aggregates the latest 1000 owner samples with the original nearest-rank percentile semantics',async()=>{
    const before=await getOperationsStatus(env,1);expect(before.telemetry).toMatchObject({request_sample_count:0,wall_time_ms:{p50:null,p95:null,p99:null}});
    await recordOperation(env,{operation:'request',outcome:'success',latency_ms:10});
    await recordOperation(env,{operation:'request',outcome:'success',latency_ms:20});
    expect((await getOperationsStatus(env,1)).telemetry.wall_time_ms).toEqual({p50:10,p95:20,p99:20});
    await db.prepare('DELETE FROM operation_events').run();
    await db.prepare(`WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n<1005)
      INSERT INTO operation_events(correlation_id,user_id,operation,outcome,latency_ms,created_at)
      SELECT '00000000-0000-4000-8000-000000000000',1,'request','success',n,
        strftime('%Y-%m-%dT%H:%M:%fZ',?,printf('+%d seconds',n)) FROM counter`).bind(new Date(Date.now()-7200000).toISOString()).run();
    await recordOperation(env,{operation:'request',outcome:'success',latency_ms:999999,user_id:2});
    const status=await getOperationsStatus(env,1);expect(status.telemetry).toMatchObject({request_sample_count:1000,wall_time_ms:{p50:505,p95:955,p99:995}});
  });
  it('persists only whitelisted redacted fields and keeps other owners out of metrics',async()=>{
    await recordOperation(env,{operation:'request',outcome:'success',latency_ms:40,prompt:'private resume',headers:{Authorization:'secret'},model:'key=gsk_secret'} as any);
    await recordOperation(env,{operation:'request',outcome:'failed',latency_ms:900,user_id:2});
    const rows=(await db.prepare('SELECT * FROM operation_events').all()).results;expect(JSON.stringify(rows)).not.toMatch(/private resume|Authorization|secret/);expect(rows[0]).toMatchObject({user_id:1,correlation_id:env.OPERATION_CONTEXT!.correlation_id,model:null});
    const status=await getOperationsStatus(env,1);expect(status.telemetry.request_sample_count).toBe(1);expect(status.telemetry.wall_time_ms).toEqual({p50:40,p95:40,p99:40});expect(status.telemetry.cpu_time_ms).toBeNull();expect(status.telemetry.memory_bytes).toBeNull();
  });
  it('reports budget/backlog alerts and configurable spacing without promising unreserved capacity',async()=>{
    const day=new Date().toISOString().slice(0,10);await db.prepare('INSERT INTO browser_budget(day,reserved_seconds) VALUES(?,540)').bind(day).run();
    const status=await getOperationsStatus({...env,SUBMISSION_DELAY_SECONDS:'45'},1);expect(status.capacity).toMatchObject({remaining_application_slots:0,submission_delay_seconds:45});expect(status.alerts.join(' ')).toContain('cannot start another');
  });
  it('alerts on repeated recent provider failures and stuck processing without exposing another owner',async()=>{
    for(let i=0;i<3;i++)await recordOperation(env,{operation:'provider_text',provider:'groq',outcome:'failed',latency_ms:50,error_kind:'rate_limited'});
    await db.prepare("INSERT INTO jobs(title,company,url,listing_type) VALUES('Synthetic Intern','Synthetic Co','https://example.com/apply','internship')").run();
    await db.prepare("INSERT INTO applications(user_id,job_id,status,processing_started_at) VALUES(1,1,'applying',?)").bind(new Date(Date.now()-11*60000).toISOString()).run();
    const status=await getOperationsStatus(env,1);expect(status.capacity).toMatchObject({recent_provider_failures:3,stuck_processing:1});expect(status.alerts.join(' ')).toContain('last 15 minutes');expect(status.alerts.join(' ')).toContain('duplicate submission');
    const other=await getOperationsStatus(env,2);expect(other.capacity).toMatchObject({recent_provider_failures:0,stuck_processing:0});expect(other.alerts.join(' ')).not.toContain('last 15 minutes');
  });
  it.each([['1',21000],['-5',21000],['0',21000],['garbage',21000],['25',25000],['999',300000]])('clamps submission delay %s to %s ms',(configured,expected)=>{expect(submissionDelayMs({...env,SUBMISSION_DELAY_SECONDS:configured})).toBe(expected);});
  it('clamps daily browser allocation to the conservative free allowance',()=>{expect(browserDailyBudgetSeconds({...env,BROWSER_DAILY_BUDGET_SECONDS:'900'})).toBe(540);expect(browserDailyBudgetSeconds({...env,BROWSER_DAILY_BUDGET_SECONDS:'0'})).toBe(0);expect(browserDailyBudgetSeconds({...env,BROWSER_DAILY_BUDGET_SECONDS:'not-a-number'})).toBe(0);});
  it('marks stale health honestly and prunes old events without changing current facts',async()=>{
    await recordProviderOutcome(env,'groq','configured-groq',{success:false,latency_ms:10,failure:classifyProviderError('groq',null,{status:503})});
    await db.prepare("UPDATE provider_health SET checked_at='2000-01-01T00:00:00.000Z'").run();expect((await safeProviderHealth(env))[0].state).toBe('unknown');
    await db.prepare("UPDATE operation_events SET created_at='2000-01-01T00:00:00.000Z'").run();await recordOperation(env,{operation:'request',outcome:'success',latency_ms:20});await pruneOperations(env);expect((await db.prepare('SELECT * FROM operation_events').all()).results).toHaveLength(1);expect((await db.prepare('SELECT count(*) AS n FROM users').first<any>())!.n).toBe(2);
  });
});
