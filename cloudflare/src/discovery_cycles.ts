/** Resumable public discovery. Importing opportunities never authorizes submission. */
import {ApiError,type Env,type Row,parsed} from './types';
import {all,first,run,userById} from './storage';
import {addJobs} from './plans';
import {searchDiscoveryPage,verifyDiscoveryDetail,discoveryCanonicalIdentity,extractSkills} from './intelligence';
import {canonicalListingUrl,parseExperience} from './listing_details';
import {SourceDeferred,pruneSourceCache,discoveryUsageLimit} from './source_reader';
import {newOperationContext} from './telemetry';
const definitions:Record<string,{name:string;domains:string[]}>= {
 internshala:{name:'Internshala',domains:['internshala.com']},wellfound:{name:'Wellfound',domains:['wellfound.com']},greenhouse:{name:'Greenhouse',domains:['job-boards.greenhouse.io','boards.greenhouse.io']},lever:{name:'Lever',domains:['jobs.lever.co','jobs.eu.lever.co']},linkedin:{name:'LinkedIn',domains:['linkedin.com']},naukri:{name:'Naukri',domains:['naukri.com']},ashby:{name:'Ashby',domains:['jobs.ashbyhq.com']},
};
const str=(x:unknown)=>typeof x==='string'?x.trim():'';
const words=(x:unknown)=>Array.isArray(x)?x.filter((v):v is string=>typeof v==='string'&&v.length<=300):[];
const knownStates=['queued','running','completed','partial','paused','cancelled','failed'];
function integer(x:unknown,fallback:number,min:number,max:number){const n=x==null?fallback:Number(x);if(!Number.isInteger(n)||n<min||n>max)throw new ApiError(422,`Use a whole number from ${min} to ${max}`);return n;}
export function discoveryQueryPlan(profile:Row,maximum:number){
 const mode=profile.mode==='internship'?'internship':'job',ids=mode==='internship'?['internshala','wellfound','greenhouse','lever','linkedin','ashby']:['naukri','linkedin','greenhouse','lever','ashby'];
 const roles=words(profile.target_roles).slice(0,3),skills=words(profile.skills).slice(0,4),locations=words(profile.preferred_locations).slice(0,3);
 const queries:Row[]=[];for(let page=0;queries.length<maximum&&page<8;page++)for(const id of ids){if(queries.length>=maximum)break;const role=roles[page%Math.max(1,roles.length)]||'software engineer';const location=locations[page%Math.max(1,locations.length)]||'';const skill=skills[page%Math.max(1,skills.length)]||'';const qualifier=page===0?'':page%3===1?'engineering team':page%3===2?'current openings':'developer careers';queries.push({source_id:id,domains:definitions[id].domains,query:`${role} ${mode} ${location} ${skill} ${Number(profile.experience_years||0)<=1?'entry level fresher':''} ${qualifier}`.replace(/\s+/g,' ').trim(),variant:page});}
 return queries;
}
export function discoveryFit(job:Row,profile:Row){
 const mode=profile.mode==='internship'?'internship':'job';if(job.listing_type!==mode)return{accepted:false,reason:'mode_mismatch'};
 const body=`${job.title||''} ${job.description||''}`,found=extractSkills(body),provided=words(profile.skills);
 if(provided.length&&!provided.some(skill=>found.some(value=>value.toLowerCase()===skill.toLowerCase())||new RegExp(`(^|\\W)${skill.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?=$|\\W)`,'i').test(body)))return{accepted:false,reason:'skill_mismatch'};
 const targets=words(profile.target_roles).flatMap(value=>value.toLowerCase().split(/\W+/)).filter(value=>value.length>2&&!['and','the','intern','internship','job','senior','junior'].includes(value));
 if(targets.length&&!targets.some(value=>new RegExp(`\\b${value}\\b`,'i').test(body)))return{accepted:false,reason:'role_mismatch'};
 const experience=typeof job.required_experience==='object'?job.required_experience:parseExperience(job.description||'');
 if(experience&&Number(experience.minimum_years)>Number(profile.experience_years||0)+1)return{accepted:false,reason:'experience_mismatch'};
 const locations=words(profile.preferred_locations).map(value=>value.toLowerCase()),location=str(job.location).toLowerCase(),text=body.toLowerCase();
 let geography='no_preference';
 if(locations.length){
  const countries=locations.filter(value=>!/^remote(?: work)?$/.test(value));
  const explicit=countries.some(value=>location.includes(value));
  const worldwide=/\b(worldwide|anywhere in the world|global remote|remote anywhere)\b/.test(`${location} ${text}`);
  const restricted=/\b(?:must (?:be |reside |live )|only |based )[^.!\n]{0,45}\b(?:united states|usa|u\.s\.|canada|united kingdom|europe)\b/.test(text);
  if(countries.length&&!explicit&&!worldwide)return{accepted:false,reason:location?'geography_mismatch':'geography_unknown'};
  if(!countries.length&&locations.includes('remote')&&!/\bremote\b/.test(location))return{accepted:false,reason:location?'geography_mismatch':'geography_unknown'};
  if(restricted&&!explicit)return{accepted:false,reason:'geography_restricted'};
  geography=explicit?'explicit_location':worldwide?'explicit_worldwide':'remote_country_unspecified';
 }
 return{accepted:true,reason:'matched_explicit_preferences',geography,skills:found};
}
async function dispatch(env:Env,row:Row){try{const delay=Math.max(0,Math.min(300,Math.ceil((Date.parse(row.next_wake_at||'')-Date.now())/1000)||0));await env.APPLICATION_QUEUE.send({kind:'discovery_cycle',cycle_id:row.id},{delaySeconds:delay});await run(env,"UPDATE discovery_cycles SET dispatched_at=? WHERE id=? AND state='queued'",new Date().toISOString(),row.id);}catch{/* durable state is recovered by maintenance */}}
function publicCycle(row:Row,counts:Row){const sources=parsed<Row[]>(row.sources_json,[]);return{id:row.id,state:row.state,target_count:row.target_count,verified_count:row.verified_count,imported_count:row.imported_count,search_calls:row.search_calls,detail_checks:row.detail_calls,search_accounting:'reserved_attempts; interrupted or unknown outcomes consume budget',detail_accounting:'reserved_checks; only proven zero-read deferrals release the per-cycle reservation',budgets:{searches:row.max_searches,detail_checks:row.max_details},pending:(counts.pending||0)+(counts.claimed||0),rejected:counts.rejected||0,errors:counts.error||0,cancelled:row.state==='cancelled',sources,next_retry_at:row.next_wake_at,created_at:row.created_at,finished_at:row.finished_at,detail:row.failure_reason,precision:parsed(row.precision_json,{}),message:row.state==='completed'?`${row.verified_count} verified opportunities collected.`:['partial','paused','cancelled'].includes(row.state)?`${row.verified_count} verified opportunities retained out of ${row.target_count} requested. ${row.failure_reason||'Unavailable and unsuitable results were omitted.'}`:'Discovery is running in bounded steps; each verified result is saved.'};}
export async function startDiscoveryCycle(env:Env,userId:number,options:Row={}){
 const user=await userById(env,userId),target=integer(options.target,100,1,150),searches=integer(options.max_search_calls,Math.min(25,Math.max(6,Math.ceil(target/5))),5,30),details=integer(options.max_detail_checks,Math.min(300,target*3),1,400),now=new Date().toISOString();
 const active=await first(env,"SELECT * FROM discovery_cycles WHERE user_id=? AND state IN ('queued','running')",userId);if(active)return publicCycle(active,{});
 const attempt=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END WHERE window_start<=? OR attempts<3 RETURNING attempts`,`discovery-cycle:${userId}`,Date.now(),Date.now()-600000,Date.now()-600000,Date.now()-600000);if(!attempt)throw new ApiError(429,'Three discovery cycles were requested. Wait ten minutes before starting another.');
 const id=crypto.randomUUID(),profile={...user.master_profile,mode:user.mode},queries=discoveryQueryPlan(profile,searches),sources=[...new Set(queries.map(query=>query.source_id))].map(key=>({id:key,name:definitions[key].name,search_calls:0,searched:0,verified:0,rejected:0,restricted:0,status:'pending'}));
 const row=await first(env,`INSERT INTO discovery_cycles(id,user_id,profile_version,mode,profile_snapshot,target_count,max_searches,max_details,queries_json,sources_json,created_at,updated_at,expires_at,schedule_run_id) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM users WHERE id=? AND profile_version=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM weekly_schedule_runs WHERE id=? AND user_id=? AND state='running')) ON CONFLICT DO NOTHING RETURNING *`,id,userId,user.profile_version,user.mode,JSON.stringify(profile),target,searches,details,JSON.stringify(queries),JSON.stringify(sources),now,now,new Date(Date.now()+48*3600000).toISOString(),options.schedule_run_id??null,userId,user.profile_version,options.schedule_run_id??null,options.schedule_run_id??null,userId);
 if(!row)throw new ApiError(409,'Your workspace changed; refresh before starting discovery.');await dispatch(env,row);return publicCycle(row,{});
}
export async function discoveryCycleStatus(env:Env,userId:number,id?:string){
 const row=await first(env,`SELECT * FROM discovery_cycles WHERE user_id=? ${id?'AND id=?':''} ORDER BY created_at DESC LIMIT 1`,userId,...(id?[id]:[]));if(!row)throw new ApiError(404,'No discovery cycle found');
 const counts=await all(env,'SELECT state,count(*) AS n FROM discovery_candidates WHERE cycle_id=? GROUP BY state',row.id);return publicCycle(row,Object.fromEntries(counts.map(value=>[value.state,value.n])));
}
export async function changeDiscoveryCycle(env:Env,userId:number,id:string,action:'cancel'|'resume'){
 const user=await userById(env,userId),row=await first(env,'SELECT * FROM discovery_cycles WHERE id=? AND user_id=?',id,userId);if(!row)throw new ApiError(404,'Discovery cycle not found');
 if(action==='cancel'){await env.DB.batch([
 env.DB.prepare("UPDATE discovery_cycles SET state='cancelled',lease_token=NULL,lease_expires_at=NULL,finished_at=?,failure_reason='Cancelled by you. Verified opportunities are retained.' WHERE id=? AND user_id=? AND state IN ('queued','running','paused')").bind(new Date().toISOString(),id,userId),
 env.DB.prepare("UPDATE discovery_candidates SET state='pending',claim_token=NULL WHERE cycle_id=? AND state='claimed' AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND user_id=? AND state='cancelled')").bind(id,id,userId),
 ]);}
 else{
  if(!['cancelled','paused','failed'].includes(row.state))throw new ApiError(409,'Only a stopped cycle can be resumed.');
  if(row.profile_version!==user.profile_version||row.mode!==user.mode||Date.parse(row.expires_at)<=Date.now())throw new ApiError(409,'This checkpoint belongs to an old profile or has expired. Start a new cycle.');
  if(row.state==='paused'&&Date.parse(row.next_wake_at)>Date.now())throw new ApiError(429,'The discovery allowance is not available yet. Existing results are preserved.');
  try{await env.DB.batch([
   env.DB.prepare("UPDATE discovery_cycles SET state='queued',lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL,failure_reason=NULL,finished_at=NULL,next_wake_at=NULL WHERE id=? AND user_id=? AND state IN ('cancelled','paused','failed')").bind(id,userId),
   env.DB.prepare("UPDATE discovery_candidates SET state='pending',claim_token=NULL WHERE cycle_id=? AND state='claimed' AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND user_id=? AND state='queued')").bind(id,id,userId),
  ]);}catch{throw new ApiError(409,'Another discovery cycle is already active.');}
  await dispatch(env,{...row,state:'queued',next_wake_at:null});
 }
 return discoveryCycleStatus(env,userId,id);
}
async function scheduleNext(env:Env,cycle:Row,token:string,delay=0){
 const next=new Date(Date.now()+Math.max(0,delay)*1000).toISOString();
 const row=await first(env,"UPDATE discovery_cycles SET state='queued',lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL,next_wake_at=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? RETURNING *",next,new Date().toISOString(),cycle.id,token);if(row)await dispatch(env,row);
}
export async function processDiscoveryCycle(env:Env,id:string){
 const now=new Date().toISOString(),token=crypto.randomUUID();
 await run(env,"UPDATE discovery_cycles SET state='failed',failure_reason='Profile changed or checkpoint expired. Retained results remain available.',finished_at=?,lease_token=NULL WHERE id=? AND state IN ('queued','running') AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM users WHERE id=discovery_cycles.user_id AND profile_version=discovery_cycles.profile_version AND mode=discovery_cycles.mode))",now,id,now);
 const cycle=await first(env,`UPDATE discovery_cycles SET state='running',lease_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND state='queued' AND (next_wake_at IS NULL OR next_wake_at<=?) AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=discovery_cycles.user_id AND profile_version=discovery_cycles.profile_version AND mode=discovery_cycles.mode) RETURNING *`,token,new Date(Date.now()+90000).toISOString(),now,id,now,now);
 if(!cycle){const waiting=await first(env,"SELECT * FROM discovery_cycles WHERE id=? AND state='queued' AND next_wake_at>?",id,now);if(waiting)await dispatch(env,waiting);return;}env={...env,DISCOVERY_SHARED_GUARDS:'true',OPERATION_CONTEXT:newOperationContext(cycle.user_id)};
 const sources=parsed<Row[]>(cycle.sources_json,[]),queries=parsed<Row[]>(cycle.queries_json,[]),profile=parsed<Row>(cycle.profile_snapshot,{});
 const guarded=async()=>Boolean(await first(env,"SELECT id FROM discovery_cycles WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>? AND expires_at>? AND EXISTS(SELECT 1 FROM users WHERE id=discovery_cycles.user_id AND profile_version=discovery_cycles.profile_version)",id,token,new Date().toISOString(),new Date().toISOString()));
 try{
  if(cycle.verified_count>=cycle.target_count){await run(env,"UPDATE discovery_cycles SET state='completed',finished_at=?,lease_token=NULL WHERE id=? AND lease_token=?",now,id,token);return;}
  let candidate=await first(env,"SELECT * FROM discovery_candidates WHERE cycle_id=? AND state='pending' AND attempts<3 AND (json_extract(evidence_json,'$.deferred_until') IS NULL OR json_extract(evidence_json,'$.deferred_until')<=?) ORDER BY attempts,created_at,url LIMIT 1",id,now);
  const deferred=!candidate?await first(env,"SELECT MIN(json_extract(evidence_json,'$.deferred_until')) AS until FROM discovery_candidates WHERE cycle_id=? AND state='pending' AND attempts<3 AND json_extract(evidence_json,'$.deferred_until')>?",id,now):null;
  // Search each named source once before a portal can monopolize detail work.
  const firstRound=Math.min(sources.length,queries.length);
  // A partially used shared search allowance must not strand detail candidates
  // already collected this cycle. This read is advisory: reserveDiscoveryUsage
  // still atomically admits every actual provider request. Once the pending
  // details are drained, the normal failed reservation pauses the saved cursor.
  const preferSearch=cycle.query_cursor<queries.length&&cycle.search_calls<cycle.max_searches&&(cycle.query_cursor<firstRound||!candidate);
  const searchUsage=candidate&&preferSearch?await first(env,'SELECT searches FROM discovery_daily_usage WHERE day=?',new Date().toISOString().slice(0,10)):null;
  const searchAvailable=!candidate||!preferSearch||Number(searchUsage?.searches||0)<discoveryUsageLimit(env,'searches');
  const needSearch=preferSearch&&searchAvailable;
  if(needSearch){
   const query=queries[cycle.query_cursor],source=sources.find(row=>row.id===query.source_id)!;
   // Reserve both the attempt and cursor before the external write. A consumer
   // that disappears after sending cannot cause recovery to repeat that query
   // without charging the cycle. Global provider reservations are never refunded.
   source.search_calls++;
   const reserved=await first(env,"UPDATE discovery_cycles SET search_calls=search_calls+1,query_cursor=query_cursor+1,sources_json=?,updated_at=? WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>? AND search_calls<max_searches AND query_cursor=? RETURNING search_calls,query_cursor",JSON.stringify(sources),now,id,token,new Date().toISOString(),cycle.query_cursor);
   if(!reserved)return;Object.assign(cycle,reserved);
   let found:Row[]=[];
   try{found=await searchDiscoveryPage(env,query.query,query.domains,10);source.status='ok';}
   catch(error){
    if(error instanceof SourceDeferred){
     if(!error.attempted){source.search_calls--;await run(env,"UPDATE discovery_cycles SET search_calls=MAX(0,search_calls-1),query_cursor=MAX(0,query_cursor-1),sources_json=? WHERE id=? AND lease_token=? AND state='running' AND search_calls=? AND query_cursor=?",JSON.stringify(sources),id,token,reserved.search_calls,reserved.query_cursor);}
     // Another caller can consume the last search after our advisory read.
     // Drain already saved candidates on the next bounded step before pausing.
     if(!error.attempted&&candidate&&/^Daily discovery allowance/.test(error.reason)){await scheduleNext(env,cycle,token);return;}
     // A source's shorter wait can still permit detail work before the shared
     // search allowance resets. Never sleep the whole cycle until midnight
     // merely because all currently saved candidates are briefly deferred.
     if(!error.attempted&&deferred?.until&&/^Daily discovery allowance/.test(error.reason)&&Date.parse(deferred.until)<Date.parse(new Date().toISOString().slice(0,10))+86400000){await scheduleNext(env,cycle,token,Math.max(1,Math.ceil((Date.parse(deferred.until)-Date.now())/1000)));return;}
     throw error;
    }
    source.status='unavailable';await run(env,"UPDATE discovery_cycles SET sources_json=? WHERE id=? AND lease_token=? AND state='running'",JSON.stringify(sources),id,token);await scheduleNext(env,cycle,token,5);return;
   }
   if(!await guarded())return;source.searched+=found.length;if(!found.length)source.status='empty';
   const insert=found.flatMap(item=>{let url;try{url=discoveryCanonicalIdentity(item.url);if(!url||!query.domains.some((domain:string)=>new URL(url!).hostname===domain||new URL(url!).hostname.endsWith('.'+domain)))return[];url=canonicalListingUrl(url);}catch{return[];}return[env.DB.prepare("INSERT INTO discovery_candidates(cycle_id,url,source_id,title,company,location,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND lease_token=? AND state='running') ON CONFLICT(cycle_id,url) DO NOTHING").bind(id,url,query.source_id,str(item.title).slice(0,300),str(item.company).slice(0,300),str(item.location).slice(0,300),now,id,token)];});
   if(insert.length)await env.DB.batch(insert);await run(env,"UPDATE discovery_cycles SET sources_json=?,updated_at=? WHERE id=? AND lease_token=? AND state='running'",JSON.stringify(sources),now,id,token);
   await scheduleNext(env,cycle,token);return;
  }
  if(candidate&&cycle.detail_calls<cycle.max_details){
   candidate=await first(env,"UPDATE discovery_candidates SET state='claimed',claim_token=?,attempts=attempts+1 WHERE cycle_id=? AND url=? AND state='pending' AND attempts<3 AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>?) RETURNING *",token,id,candidate.url,id,token,new Date().toISOString());if(!candidate){await scheduleNext(env,cycle,token);return;}const candidateUrl=candidate.url;
   const reserved=await first(env,"UPDATE discovery_cycles SET detail_calls=detail_calls+1 WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>? AND detail_calls<max_details RETURNING detail_calls",id,token,new Date().toISOString());
   if(!reserved){await run(env,"UPDATE discovery_candidates SET state='pending',claim_token=NULL,attempts=MAX(0,attempts-1) WHERE cycle_id=? AND url=? AND claim_token=? AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND lease_token=? AND state='running')",id,candidateUrl,token,id,token);return;}Object.assign(cycle,reserved);
   let rejectedReason='unavailable_or_incomplete_detail';const trace:Row[]=[];
   let job:Row|null=null;
   try{job=await verifyDiscoveryDetail(env,{url:candidate.url,title:candidate.title,company:candidate.company,location:candidate.location},event=>trace.push(event));}
   catch(error){if(error instanceof SourceDeferred){
    // A redirect may already have been fetched before the next domain deferred.
    // Refund only when the trace proves there was no successful earlier read.
    const zeroRead=!error.attempted&&!trace.some(event=>Number(event.status)>0&&event.cache!=='hit');
    const until=new Date(Date.now()+Math.max(1,error.delaySeconds)*1000).toISOString();
    await run(env,"UPDATE discovery_candidates SET state=CASE WHEN attempts>=3 AND ? THEN 'error' ELSE 'pending' END,attempts=MAX(0,attempts-?),reason=?,evidence_json=?,claim_token=NULL WHERE cycle_id=? AND url=? AND claim_token=? AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND lease_token=? AND state='running')",zeroRead?0:1,zeroRead?1:0,error.reason,JSON.stringify({deferred_until:until,retry_reason:error.reason.slice(0,200)}),id,candidateUrl,token,id,token);
    if(zeroRead)await run(env,"UPDATE discovery_cycles SET detail_calls=MAX(0,detail_calls-1) WHERE id=? AND lease_token=? AND state='running' AND detail_calls=?",id,token,reserved.detail_calls);
    // Each blocked candidate keeps its own retry time. Other hosts and source
    // queries proceed on subsequent bounded messages instead of waiting for a
    // long Retry-After from an unrelated portal.
    await scheduleNext(env,cycle,token);return;
   }throw error;}
   if(!await guarded())return;
   const sourceId=candidate.source_id;const source=sources.find(value=>value.id===sourceId)!;let accepted=false,evidence:Row={};
   if(job){const fit=discoveryFit(job,profile);accepted=fit.accepted;evidence={...fit,source_kind:job.provenance?.kind,description_chars:job.description.length,canonical_url:discoveryCanonicalIdentity(job.canonical_url||job.url)||job.canonical_url||job.url,checked_at:new Date().toISOString(),posted_date:job.posted_date||null,expires_at:job.expires_at||null};rejectedReason=fit.reason;}
   else if(trace.some(event=>[403,429,999].includes(event.status))){source.restricted++;source.status='restricted';rejectedReason='source_restricted';}
   if(job&&accepted){
    // Different search URLs can redirect to the same canonical full JD. The
    // target counts distinct verified listings, not successful alias reads.
    const duplicate=await first(env,"SELECT 1 AS found FROM discovery_candidates WHERE cycle_id=? AND state='verified' AND (job_id=(SELECT id FROM jobs WHERE url=?) OR json_extract(evidence_json,'$.canonical_url')=?) LIMIT 1",id,job.url,evidence.canonical_url);
    if(duplicate){accepted=false;rejectedReason='duplicate_canonical_listing';evidence={...evidence,accepted:false,reason:rejectedReason};}
   }
   let imported=0,jobId=null;
   if(job&&accepted){imported=await addJobs(env,cycle.user_id,[job],true,{id,profileVersion:cycle.profile_version,cycle:true,token},true);const saved=await first(env,'SELECT id FROM jobs WHERE url=?',job.url);jobId=saved?.id??null;source.verified++;}
   else source.rejected++;
   const count=accepted?1:0;
   await env.DB.batch([
    env.DB.prepare("UPDATE discovery_candidates SET state=?,job_id=?,reason=?,evidence_json=?,verified_at=?,claim_token=NULL WHERE cycle_id=? AND url=? AND claim_token=? AND EXISTS(SELECT 1 FROM discovery_cycles WHERE id=? AND lease_token=? AND state='running')").bind(accepted?'verified':'rejected',jobId,rejectedReason,JSON.stringify(evidence),new Date().toISOString(),id,candidate.url,token,id,token),
    env.DB.prepare("UPDATE discovery_cycles SET verified_count=verified_count+?,imported_count=imported_count+?,sources_json=?,updated_at=? WHERE id=? AND lease_token=? AND state='running'").bind(count,imported,JSON.stringify(sources),new Date().toISOString(),id,token),
   ]);
   await scheduleNext(env,cycle,token);return;
  }
  const pending=await first(env,"SELECT COUNT(*) AS n FROM discovery_candidates WHERE cycle_id=? AND state IN ('pending','claimed')",id);
  if(!pending?.n&&cycle.query_cursor<queries.length&&cycle.search_calls<cycle.max_searches){await scheduleNext(env,cycle,token);return;}
  if(pending?.n&&deferred?.until&&cycle.detail_calls<cycle.max_details){await scheduleNext(env,cycle,token,Math.max(1,Math.ceil((Date.parse(deferred.until)-Date.now())/1000)));return;}
  const reason=cycle.detail_calls>=cycle.max_details?'Configured detail-check budget reached.':cycle.search_calls>=cycle.max_searches?'Configured search budget reached.':'Accessible source candidates exhausted.';
  const precision=await all(env,"SELECT reason,COUNT(*) AS n FROM discovery_candidates WHERE cycle_id=? GROUP BY reason",id);
  await run(env,"UPDATE discovery_cycles SET state='partial',failure_reason=?,finished_at=?,lease_token=NULL,lease_expires_at=NULL,precision_json=? WHERE id=? AND lease_token=?",reason,new Date().toISOString(),JSON.stringify({measured:true,policy:'explicit_mode_skill_experience_geography',candidate_reasons:precision,unknown_fields_retained:true,not_independent_human_precision:true}),id,token);
 }catch(error){
  if(error instanceof SourceDeferred){const daily=/Daily discovery/.test(error.reason);await run(env,"UPDATE discovery_cycles SET state=?,failure_reason=?,next_wake_at=?,lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE id=? AND lease_token=?",daily?'paused':'queued',error.reason,new Date(Date.now()+error.delaySeconds*1000).toISOString(),id,token);if(!daily)await dispatch(env,{...cycle,next_wake_at:new Date(Date.now()+error.delaySeconds*1000).toISOString()});return;}
  await run(env,"UPDATE discovery_candidates SET state=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,reason='Temporary verification failure',claim_token=NULL WHERE cycle_id=? AND claim_token=?",id,token);
  await scheduleNext(env,cycle,token,10);
 }
}
export async function recoverDiscoveryCycles(env:Env){
 const now=new Date().toISOString();
 await env.DB.batch([
  env.DB.prepare("UPDATE discovery_cycles SET state='failed',failure_reason='Profile changed or checkpoint expired. Retained results remain available.',finished_at=?,lease_token=NULL WHERE state IN ('queued','running') AND (expires_at<=? OR NOT EXISTS(SELECT 1 FROM users WHERE id=discovery_cycles.user_id AND profile_version=discovery_cycles.profile_version AND mode=discovery_cycles.mode))").bind(now,now),
  env.DB.prepare("UPDATE discovery_candidates SET state=CASE WHEN attempts>=3 THEN 'error' ELSE 'pending' END,claim_token=NULL WHERE state='claimed' AND cycle_id IN (SELECT id FROM discovery_cycles WHERE state='running' AND lease_expires_at<=?)").bind(now),
  env.DB.prepare("UPDATE discovery_cycles SET state='queued',lease_token=NULL,lease_expires_at=NULL,dispatched_at=NULL WHERE state='running' AND lease_expires_at<=? AND expires_at>?").bind(now,now),
 ]);
 const rows=await all(env,"SELECT * FROM discovery_cycles WHERE state='queued' AND (dispatched_at IS NULL OR dispatched_at<?) AND (next_wake_at IS NULL OR next_wake_at<=?) ORDER BY created_at LIMIT 5",new Date(Date.now()-600000).toISOString(),now);for(const row of rows)await dispatch(env,row);
 await run(env,"DELETE FROM discovery_cycles WHERE state NOT IN ('queued','running') AND updated_at<?",new Date(Date.now()-7*86400000).toISOString());await pruneSourceCache(env);
}
