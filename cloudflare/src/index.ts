import {startPrepRefresh,prepRefreshStatus} from './prep_refresh';
import { ApiError, type Env, type Row, type Task, json, parsed } from './types';
import { all, first, run, userById, applicationQuery, historicalListing } from './storage';
import { checkAccessCode, logout, requireUser, sessionUser, startSession } from './auth';
import { readJson, saveProfile } from './profile';
import { addJobs, confirmPlan, getPlan, swapPlan, refreshMatches } from './plans';
import { scoreMatch } from './intelligence';
import { emailReport, generateReport, latestReport } from './reports';
import {emailReadiness,emailDeliveryStatus} from './email_delivery';
import {receiveEmailWebhook} from './email_webhooks';
import { processTask } from './tasks';
import {workspaceBackupRoutes} from './workspace_backup';
import {schedulerRoutes} from './weekly_scheduler';
import { discoveryStatus, startDiscovery } from './discovery_tasks';
import {startDiscoveryCycle,discoveryCycleStatus,changeDiscoveryCycle} from './discovery_cycles';
import { files } from './files';
import {startPrepExport,getPrepExports,prepExportStatus,downloadPrepExport} from './prep_exports';
import { createTransfer, consumeTransfer } from './session_transfer';
import { accountSecurity } from './account_security';
import { cancelQueuedApplication, createSubmissionReview, editResume, regenerateResume, rejectResume, resumeDraft, reviewQuestions } from './reviews';
import { getOperationsStatus, newOperationContext, recordOperation } from './telemetry';
import { runModelDiagnostics, safeProviderHealth } from './provider_health';

function number(value: string | null, fallback?: number, max = Number.MAX_SAFE_INTEGER) {
  const n = value === null && fallback !== undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > max) throw new ApiError(422, 'Invalid ID or pagination value');
  return n;
}
async function privateFile(env: Env, key: string, type: string, filename?: string) {
  const object = await files(env).get(key);
  if (!object) throw new ApiError(404, 'File not found');
  return new Response(object.body, {headers:{'Content-Type':type,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
    ...(filename?{'Content-Disposition':`inline; filename="${filename}"`}:{}),
    ...(type.startsWith('text/html')?{'Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"}:{}),
  }});
}
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url); const path = url.pathname.replace(/\/$/,'') || '/'; const method = request.method;
  let match: RegExpMatchArray | null;
  if (method==='GET' && path==='/') return json({message:'HireFlow API is running',runtime:'cloudflare-workers'});
  if (method==='GET' && path==='/health') {
    await first(env,'SELECT id FROM users LIMIT 1');
    return json({status:'ok',runtime:'cloudflare-workers'});
  }
  if (method==='GET' && path==='/docs') return json({title:'HireFlow Cloudflare API',authentication:'Create a profile through the dashboard. Private requests require its HttpOnly session cookie. Administrative recovery uses a separate operator credential.',
    endpoints:['POST /profile','GET/PATCH /profile/{id}','POST /session/login','POST /session/logout','GET /session','POST /jobs/{id}','POST /jobs/{id}/discover','GET /weekly-plan/{id}','POST /weekly-plan/{id}/swap','POST /weekly-plan/{id}/confirm','GET /applications/{id}','GET /applications/{application_id}/prep-guide','GET /resumes/{id}','GET /resumes/{id}/{application_id}/download','POST /report/{id}/generate','GET /report/{id}/latest','GET /report/{id}/latest/html','POST /report/{id}/latest/email','POST /hiring/shortlist']});
  if((match=path.match(/^\/email\/webhooks\/(resend|sendgrid)$/)))return receiveEmailWebhook(request,env,match[1] as 'resend'|'sendgrid');
  const lifecycle=await workspaceBackupRoutes(request,env,async task=>{await env.APPLICATION_QUEUE.send(task);});
  if(lifecycle)return lifecycle;
  const schedule=await schedulerRoutes(request,env);if(schedule)return schedule;
  const accountResponse=await accountSecurity(request,env);
  if(accountResponse)return accountResponse;
  if((match=path.match(/^\/operations\/(\d+)(\/diagnostics)?$/))) {
    const id=number(match[1]);await requireUser(request,env,id);
    if(method==='GET'&&!match[2])return json({...await getOperationsStatus(env,id),providers:await safeProviderHealth(env)});
    if(method==='POST'&&match[2])return json(await runModelDiagnostics(env,id));
  }
  if (method==='GET' && path==='/session') {
    const userId=await sessionUser(request,env); return json({authenticated:!!userId,...(userId?{user_id:userId}:{})});
  }
  if (method==='POST' && path==='/session/login') {
    const data=await readJson(request); await checkAccessCode(request,env,data.access_code);
    const user=typeof data.email==='string'?await first(env,'SELECT id FROM users WHERE email=?',data.email.trim().toLowerCase()):null;
    if(!user) throw new ApiError(401,'Email or access code is incorrect.');
    return json({authenticated:true,user_id:user.id},200,{'Set-Cookie':await startSession(request,env,user.id)});
  }
  if (method==='POST' && path==='/session/logout') return logout(request,env);
  if (method==='POST' && path==='/session/transfer') return createTransfer(request,env);
  if (method==='POST' && path==='/session/transfer/consume') return consumeTransfer(request,env);
  if (method==='POST' && path==='/profile') return saveProfile(request,env);
  if ((match=path.match(/^\/profile\/(\d+)$/))) {
    const id=number(match[1]); await requireUser(request,env,id);
    if(method==='GET') return json(await userById(env,id));
    if(method==='PATCH') return saveProfile(request,env,id);
  }
  if((match=path.match(/^\/jobs\/(\d+)\/discover\/([a-f0-9-]{36})$/)) && method==='GET'){
    const id=number(match[1]);await requireUser(request,env,id);return json(await discoveryStatus(env,id,match[2]));
  }
  if((match=path.match(/^\/jobs\/(\d+)\/discovery-cycles(?:\/([a-f0-9-]{36})(?:\/(cancel|resume))?)?$/))){
    const id=number(match[1]);await requireUser(request,env,id);
    if(method==='POST'&&!match[2]){const input=await readJson(request);return json(await startDiscoveryCycle(env,id,{target:input.target,max_search_calls:input.max_search_calls,max_detail_checks:input.max_detail_checks}),202);}
    if(method==='GET')return json(await discoveryCycleStatus(env,id,match[2]));
    if(method==='POST'&&match[2]&&match[3])return json(await changeDiscoveryCycle(env,id,match[2],match[3] as 'cancel'|'resume'));
  }
  if ((match=path.match(/^\/jobs\/(\d+)(\/discover)?$/)) && method==='POST') {
    const id=number(match[1]); await requireUser(request,env,id);
    if(match[2]) return json(await startDiscovery(env,id),202);
    const count=await addJobs(env,id,[await readJson(request)]); return json({imported:count,message:count?'Opportunity added. Refresh your plan.':'This listing is not eligible for the current profile.'},201);
  }
  if((match=path.match(/^\/weekly-plan\/(\d+)(?:\/(swap|confirm|refresh-matches))?$/))) {
    const id=number(match[1]); await requireUser(request,env,id);
    if(method==='GET' && !match[2]) return json(await getPlan(env,id));
    if(method==='POST') {
      const body=await readJson(request);
      if(match[2]==='refresh-matches')return json(await refreshMatches(env,id));
      if(match[2]==='swap') return json(await swapPlan(env,id,number(String(body.remove_job_id)),number(String(body.add_job_id))));
      if(match[2]==='confirm') return json(await confirmPlan(env,id,body.confirmed_job_ids,body.review_ids));
    }
  }
  if((match=path.match(/^\/applications\/(\d+)\/(resume-draft|resume-reject|resume-regenerate|review|cancel)$/))) {
    const owner=await requireUser(request,env),id=number(match[1]),action=match[2];
    if(method==='GET'&&action==='resume-draft')return json(await resumeDraft(env,owner,id));
    if(method==='GET'&&action==='review')return json(await reviewQuestions(env,owner,id));
    if(method==='PUT'&&action==='resume-draft')return json(await editResume(env,owner,id,await readJson(request)));
    if(method==='POST'&&action==='resume-reject')return json(await rejectResume(env,owner,id,await readJson(request)));
    if(method==='POST'&&action==='resume-regenerate')return json(await regenerateResume(env,owner,id,await readJson(request)));
    if(method==='POST'&&action==='review')return json(await createSubmissionReview(env,owner,id,await readJson(request)),201);
    if(method==='POST'&&action==='cancel')return json(await cancelQueuedApplication(env,owner,id));
  }
  if((match=path.match(/^\/applications\/(\d+)\/prep-guide\/refresh$/))&&method==='POST'){
    const owner=await requireUser(request,env);return json(await startPrepRefresh(env,owner,number(match[1])),202);
  }
  if((match=path.match(/^\/applications\/(\d+)\/prep-guide\/exports(?:\/([a-f0-9-]{36})(?:\/(html|pdf))?)?$/))){
    const owner=await requireUser(request,env),appId=number(match[1]);
    if(method==='POST'&&!match[2]){const data=await readJson(request),result=await startPrepExport(env,owner,appId,data);return json(result,result.state==='ready'?200:202);}
    if(method==='GET'&&!match[2])return json(await getPrepExports(env,owner,appId));
    if(method==='GET'&&match[2]&&match[3])return downloadPrepExport(env,owner,appId,match[2],match[3] as 'html'|'pdf');
    if(method==='GET'&&match[2])return json(await prepExportStatus(env,owner,appId,match[2]));
  }
  if((match=path.match(/^\/applications\/(\d+)\/prep-guide$/)) && method==='GET') {
    const id=number(match[1]); const app=await first(env,`${applicationQuery} WHERE a.id=?`,id);
    if(!app) { await requireUser(request,env); throw new ApiError(404,'Application not found'); }
    await requireUser(request,env,app.user_id);
    // Read refresh state first: completion must never be paired with the previous guide.
    const refresh=await prepRefreshStatus(env,id);
    const guide=await first(env,'SELECT g.*,(SELECT profile_version FROM users WHERE id=?) AS current_profile_version FROM prep_guides g WHERE application_id=?',app.user_id,id);
    if(!guide) throw new ApiError(404,'Prep guide is not ready yet. Refresh shortly.');
    return json({...parsed(guide.structured_data,{}),guide_revision:guide.revision,guide_source_profile_version:guide.source_profile_version,guide_source_job_version:guide.source_job_version,guide_stale:guide.source_profile_version!==guide.current_profile_version||guide.source_job_version!==historicalListing(app).facts_version,refresh,company:historicalListing(app).company,role:historicalListing(app).title,company_intel:parsed(guide.company_intel,{})});
  }
  if((match=path.match(/^\/applications\/(\d+)$/)) && method==='GET') {
    const id=number(match[1]); await requireUser(request,env,id);
    const page=number(url.searchParams.get('page'),1); const size=number(url.searchParams.get('page_size'),20,100);
    const status=url.searchParams.get('status');
    if(status&&!['pending','planned','confirmed','applying','applied','failed','needs_action','rejected','interview','offer'].includes(status)) throw new ApiError(422,'Unknown application status');
    const params:any[]=[id]; let where=' WHERE a.user_id=?'; if(status){where+=' AND a.status=?';params.push(status);}
    const count=await first(env,`SELECT count(*) AS n FROM applications a${where}`,...params);
    const rows=(await all(env,`${applicationQuery}${where} ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`,...params,size,(page-1)*size)).map(historicalListing);
    const history=await all(env,'SELECT application_id,status,reason,created_at AS timestamp FROM application_status_events WHERE application_id IN (SELECT value FROM json_each(?)) ORDER BY id',JSON.stringify(rows.map(a=>a.id)));
    const guides=await all(env,'SELECT application_id FROM prep_guides WHERE application_id IN (SELECT value FROM json_each(?))',JSON.stringify(rows.map(a=>a.id)));
    return json({items:rows.map(a=>({id:a.id,job_id:a.job_id,company:a.company,role:a.title,status:a.status,match_score:a.match_score,skill_gaps:parsed(a.skill_gaps,[]),resume_version:a.resume_version,
      listing_type:a.listing_type,source:a.source,canonical_url:a.canonical_url||a.url,application_url:a.application_url||a.url,
      required_skills:parsed(a.required_skills,[]),required_experience:parsed(a.required_experience,null),expires_at:a.expires_at,compensation:parsed(a.compensation,null),selection_process:parsed(a.selection_process,[]),provenance:parsed(a.provenance,{}),matching_method:a.matching_method,embedding_model:a.embedding_model,
      resume_url:a.resume_path?`/resumes/${id}/${a.id}/download`:null,prep_guide_url:guides.some(g=>g.application_id===a.id)?`/applications/${a.id}/prep-guide`:null,
      failure_reason:a.failure_reason,manual_action_url:a.manual_action_url,applied_at:a.applied_at,created_at:a.created_at,attempts:a.attempts,
      status_history:history.filter(h=>h.application_id===a.id).map(({application_id,...h})=>h)})),total:count!.n,page,page_size:size});
  }
  if((match=path.match(/^\/resumes\/(\d+)(?:\/(\d+)\/download)?$/)) && method==='GET') {
    const id=number(match[1]); await requireUser(request,env,id);
    if(!match[2]) {
      const rows=await all(env,`SELECT r.version,r.created_at AS generated_at,a.id AS application_id,j.company,j.title AS role FROM resumes r JOIN applications a ON a.id=r.application_id JOIN jobs j ON j.id=a.job_id WHERE a.user_id=? ORDER BY r.created_at DESC,r.version DESC`,id);
      return json({items:rows.map(r=>({...r,download_url:`/resumes/${id}/${r.application_id}/download?version=${r.version}`}))});
    }
    const app=await first(env,'SELECT * FROM applications WHERE id=? AND user_id=?',number(match[2]),id);
    if(!app) throw new ApiError(404,'Resume not found');
    const version=url.searchParams.has('version')?number(url.searchParams.get('version')):app.resume_version;
    if(!app.resume_path && !url.searchParams.has('version')) throw new ApiError(404,'Resume needs to be regenerated. Refresh the weekly plan.');
    const resume=await first(env,'SELECT object_key FROM resumes WHERE application_id=? AND version=?',app.id,version);
    if(!resume) throw new ApiError(404,'Resume not found');
    return privateFile(env,resume.object_key,'application/pdf',`${app.job_id}_resume_v${version}.pdf`);
  }
  if((match=path.match(/^\/report\/(\d+)\/(email-readiness|email-deliveries)(?:\/([a-f0-9-]{36}))?$/))&&method==='GET'){
    const id=number(match[1]);await requireUser(request,env,id);
    if(match[2]==='email-readiness'&&!match[3])return json(emailReadiness(env));
    if(match[2]==='email-deliveries'&&match[3])return json(await emailDeliveryStatus(env,id,match[3]));
    throw new ApiError(404,'Not found');
  }
  if((match=path.match(/^\/report\/(\d+)\/(generate|latest)(?:\/(html|email))?$/))) {
    const id=number(match[1]); await requireUser(request,env,id);
    if(method==='POST' && match[2]==='generate'&&!match[3]) return json(await generateReport(env,id));
    if(method==='POST' && match[2]==='latest'&&match[3]==='email') {const delivery=await emailReport(env,id);return json(delivery,['accepted','delivered'].includes(delivery.state)?200:202);}
    if(method==='GET' && match[2]==='latest') {
      const report=await latestReport(env,id);
      return match[3]==='html'?privateFile(env,report.html_path,'text/html; charset=utf-8'):!match[3]?json(report):json({detail:'Not found'},404);
    }
  }
  if(path==='/hiring/shortlist'&&method==='POST') {
    const owner=await requireUser(request,env); const data=await readJson(request);
    if(typeof data.jd_text!=='string'||!data.jd_text.trim()||data.jd_text.length>30000) throw new ApiError(422,'Provide a job description up to 30000 characters');
    const applicants=typeof data.applicants==='string'?parseCsv(data.applicants):data.applicants;
    if(!Array.isArray(applicants)||applicants.length>200) throw new ApiError(422,'Provide up to 200 applicants as JSON or CSV');
    const size=number(String(data.shortlist_size??20),20,200);
    const scored=applicants.map((a:Row,i:number)=>{
      if(!a||typeof a.name!=='string') throw new ApiError(422,'Every applicant needs a name');
      const profile={...a,skills:typeof a.skills==='string'?a.skills.split(/[;,|]/).map((s:string)=>s.trim()):a.skills||[]};
      if(!Array.isArray(profile.skills)) throw new ApiError(422,'Applicant skills must be a list');
      const match=scoreMatch(profile,{title:data.jd_text.split('\n')[0],description:data.jd_text});
      return {...a,score:match.score,matched_skills:match.matched,skill_gaps:match.gaps,input_index:i};
    }).sort((a,b)=>b.score-a.score||a.input_index-b.input_index);
    const shortlist=scored.filter(a=>a.matched_skills.length).slice(0,size).map(({input_index,...a})=>a);
    const result=await run(env,'INSERT INTO shortlists(user_id,jd_text,candidates,applicant_count) VALUES(?,?,?,?)',owner,data.jd_text,JSON.stringify(shortlist),applicants.length);
    return json({id:result.meta.last_row_id,shortlist,applicant_count:applicants.length,shortlisted_count:shortlist.length,summary:`Selected ${shortlist.length} of ${applicants.length} applicants with matching JD skills.`});
  }
  throw new ApiError(404,'Not found');
}
export function parseCsv(csv: string): Row[] {
  const rows:string[][]=[]; let row:string[]=[]; let cell='';let quoted=false;
  for(let i=0;i<csv.length;i++) {
    const c=csv[i];
    if(c==='"'){if(quoted&&csv[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(!quoted&&(c===','||c==='\n')){row.push(cell.trim());cell='';if(c==='\n'){rows.push(row);row=[];}}
    else if(c!=='\r')cell+=c;
  }
  if(quoted)throw new ApiError(422,'Malformed CSV quoting');
  if(cell||row.length){row.push(cell.trim());rows.push(row);}
  const headers=rows.shift()||[];
  if(!headers.includes('name'))throw new ApiError(422,'CSV needs a name column');
  return rows.filter(r=>r.some(Boolean)).map(r=>Object.fromEntries(headers.map((h,i)=>[h,r[i]||''])));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started=Date.now();env={...env,OPERATION_CONTEXT:newOperationContext()};
    const origin=request.headers.get('origin'); const origins=(env.ALLOWED_ORIGINS||'').split(',').map((s:string)=>s.trim()).filter(Boolean);
    const allowed=!origin||origins.includes(origin)||origin===new URL(request.url).origin;
    let response:Response;
    try {
      if(!allowed)throw new ApiError(403,'Origin is not allowed');
      if(request.method==='OPTIONS')response=new Response(null,{status:204});
      else response=await route(request,env);
    } catch(error) {
      if(!(error instanceof ApiError))console.error(JSON.stringify({event:'request_failed',path:new URL(request.url).pathname}));
      response=json({detail:error instanceof ApiError?error.message:'The request could not be completed. Please try again.'},error instanceof ApiError?error.status:503);
    }
    const headers=new Headers(response.headers);
    if(origin&&allowed){headers.set('Access-Control-Allow-Origin',origin);headers.set('Access-Control-Allow-Credentials','true');headers.set('Vary','Origin');}
    headers.set('Access-Control-Allow-Methods','GET, POST, PUT, PATCH, DELETE, OPTIONS'); headers.set('Access-Control-Allow-Headers','Content-Type, X-HireFlow-Access-Code');
    headers.set('X-Request-ID',env.OPERATION_CONTEXT!.correlation_id);headers.set('Access-Control-Expose-Headers','X-Request-ID');
    headers.set('X-Content-Type-Options','nosniff');
    if(request.method!=='OPTIONS')await recordOperation(env,{operation:'request',outcome:response.status<400?'success':response.status===429?'limited':'failed',http_status:response.status,latency_ms:Date.now()-started});
    return new Response(response.body,{status:response.status,headers});
  },
  async queue(batch: MessageBatch<Task>, env: Env) {
    for(const message of batch.messages){
      try { await processTask(env,message); }
      catch { console.error(JSON.stringify({event:'queue_processing_failed',application_id:message.body&&'application_id' in message.body?message.body.application_id:undefined})); message.retry({delaySeconds:120}); }
    }
  },
  async scheduled(_event: ScheduledController, env: Env) { await env.APPLICATION_QUEUE.send({kind:'maintenance'}); },
} satisfies ExportedHandler<Env,Task>;
