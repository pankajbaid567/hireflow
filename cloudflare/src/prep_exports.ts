/** Private immutable exports of saved guides; no inference, email or application approval. */
import {ApiError,type Env,type Row,parsed} from './types';
import {all,first,run,historicalListing} from './storage';
import {digest} from './auth';
import {files} from './files';
import {prepDocument,prepHtml,prepPdf} from './prep_document';
import {ResumeFormatError} from './resume_unicode';
const retention=30*86400_000,workLifetime=5*60_000;
const changed='The guide or profile changed during export. Create a new export from the current guide.';
const unavailable='The guide export could not finish. Your saved guide is unchanged; create a new export to retry.';
const expired='This guide export expired. Create a new export from the saved guide.';
const currentJobVersion=`COALESCE(CASE WHEN a.status IN ('pending','planned') THEN j.facts_version ELSE json_extract(a.job_snapshot,'$.facts_version') END,j.facts_version)`;
const exportQuery=`SELECT e.*,u.profile_version AS current_profile_version,g.revision AS current_guide_revision,${currentJobVersion} AS current_job_version
 FROM prep_guide_exports e JOIN applications a ON a.id=e.application_id AND a.user_id=e.user_id JOIN users u ON u.id=e.user_id JOIN jobs j ON j.id=a.job_id JOIN prep_guides g ON g.id=e.guide_id AND g.application_id=a.id`;
async function owned(env:Env,userId:number,appId:number){if(!await first(env,'SELECT id FROM applications WHERE id=? AND user_id=?',appId,userId))throw new ApiError(404,'Application not found');}
const bindingChanged=(row:Row)=>row.profile_version!==row.current_profile_version||row.guide_revision!==row.current_guide_revision||row.job_version!==row.current_job_version;
function metadata(row:Row){
 const isExpired=Date.parse(row.expires_at)<=Date.now(),state=isExpired?'expired':row.state,base=`/applications/${row.application_id}/prep-guide/exports/${row.id}`;
 return{id:row.id,export_id:row.id,application_id:row.application_id,version:row.version,state,created_at:row.created_at,finished_at:row.finished_at,expires_at:row.expires_at,
  source:{guide_id:row.guide_id,guide_revision:row.guide_revision,profile_version:row.profile_version,job_version:row.job_version,guide_profile_version:row.guide_profile_version,guide_job_version:row.guide_job_version},
  stale:bindingChanged(row)||(row.guide_profile_version!=null&&row.guide_profile_version!==row.current_profile_version)||(row.guide_job_version!=null&&row.guide_job_version!==row.current_job_version),
  ...(state==='ready'?{html_url:`${base}/html`,pdf_url:`${base}/pdf`}:{}),
  ...(state==='expired'?{failure_reason:expired}:row.failure_reason?{failure_reason:row.failure_reason}:{})};
}
async function snapshot(env:Env,userId:number,appId:number){
 const row=await first(env,`SELECT a.id AS application_id,a.user_id,a.status,a.job_snapshot,j.title,j.company,j.url,j.facts_version,
  u.profile_version,g.id AS guide_id,g.revision,g.created_at AS guide_created_at,g.structured_data,g.company_intel,g.source_profile_version,g.source_job_version
  FROM applications a JOIN users u ON u.id=a.user_id JOIN jobs j ON j.id=a.job_id LEFT JOIN prep_guides g ON g.application_id=a.id WHERE a.id=? AND a.user_id=?`,appId,userId);
 if(!row)throw new ApiError(404,'Application not found');if(!row.guide_id)throw new ApiError(409,'The saved prep guide is not ready yet. Refresh it before exporting.');
 const listing=historicalListing(row);
 const input={renderer_version:2,application_id:appId,company:listing.company,role:listing.title,listing_url:listing.url,guide_id:row.guide_id,guide_revision:row.revision,guide_created_at:row.guide_created_at,
  profile_version:row.profile_version,job_version:listing.facts_version,source_profile_version:row.source_profile_version,source_job_version:row.source_job_version,guide:row.structured_data,company_intel:row.company_intel};
 if(JSON.stringify(input).length>150000)throw new ApiError(413,'The saved guide is too large to export. Shorten its content before exporting.');
 return{input,hash:await digest(JSON.stringify(input))};
}
async function dispatch(env:Env,row:Row){try{await env.APPLICATION_QUEUE.send({kind:'prep_export',export_id:row.id});await run(env,"UPDATE prep_guide_exports SET dispatched_at=? WHERE id=? AND state='queued'",new Date().toISOString(),row.id);}catch{/* Durable undispatched tickets are recovered by maintenance. */}}
export async function startPrepExport(env:Env,userId:number,appId:number,options:Row={}){
 const {input,hash}=await snapshot(env,userId,appId),now=new Date().toISOString();
 await run(env,"UPDATE prep_guide_exports SET state='failed',failure_reason=CASE WHEN work_expires_at<=? THEN 'Guide export timed out. Create a new export; the saved guide is unchanged.' ELSE ? END,finished_at=?,input_snapshot='{}' WHERE application_id=? AND user_id=? AND state IN ('queued','running') AND (snapshot_hash<>? OR work_expires_at<=?)",now,changed,now,appId,userId,hash,now);
 let row=await first(env,`${exportQuery} WHERE e.application_id=? AND e.user_id=? AND e.state IN ('queued','running')`,appId,userId);
 if(row){if(row.state==='queued'&&!row.dispatched_at)await dispatch(env,row);return metadata(row);}
 if(options.regenerate!==true){row=await first(env,`${exportQuery} WHERE e.application_id=? AND e.user_id=? AND e.snapshot_hash=? AND e.state='ready' AND e.expires_at>? ORDER BY e.version DESC LIMIT 1`,appId,userId,hash,now);if(row)return metadata(row);}
 const time=Date.now(),cutoff=time-600_000;
 const allowed=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN window_start<=? THEN 1 ELSE attempts+1 END,window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END WHERE window_start<=? OR attempts<3 RETURNING attempts`,`prep-export:${appId}`,time,cutoff,cutoff,cutoff);
 if(!allowed)throw new ApiError(429,'Three guide exports were requested. Please wait ten minutes before creating another version.');
 const id=crypto.randomUUID(),prefix=`prep-guides/${userId}/${appId}/${id}`;
 const inserted=await first(env,`INSERT INTO prep_guide_exports(id,application_id,user_id,guide_id,version,guide_revision,profile_version,job_version,guide_profile_version,guide_job_version,snapshot_hash,input_snapshot,html_key,pdf_key,created_at,expires_at,work_expires_at)
  SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM applications a JOIN users u ON u.id=a.user_id JOIN jobs j ON j.id=a.job_id JOIN prep_guides g ON g.application_id=a.id WHERE a.id=? AND a.user_id=? AND u.profile_version=? AND g.id=? AND g.revision=? AND ${currentJobVersion}=?)
  ON CONFLICT DO NOTHING RETURNING *`,id,appId,userId,input.guide_id,(await first(env,'SELECT COALESCE(MAX(version),0)+1 AS version FROM prep_guide_exports WHERE application_id=?',appId))!.version,input.guide_revision,input.profile_version,input.job_version,input.source_profile_version,input.source_job_version,hash,JSON.stringify(input),`${prefix}.html`,`${prefix}.pdf`,now,new Date(time+retention).toISOString(),new Date(time+workLifetime).toISOString(),appId,userId,input.profile_version,input.guide_id,input.guide_revision,input.job_version);
 if(inserted)await dispatch(env,inserted);
 row=await first(env,`${exportQuery} WHERE e.application_id=? AND e.user_id=? AND (e.id=? OR e.state IN ('queued','running')) ORDER BY e.version DESC LIMIT 1`,appId,userId,id);
 if(!row)throw new ApiError(409,changed);return metadata(row);
}
export async function getPrepExports(env:Env,userId:number,appId:number){await owned(env,userId,appId);const rows=await all(env,`${exportQuery} WHERE e.application_id=? AND e.user_id=? ORDER BY e.version DESC LIMIT 20`,appId,userId);return{latest:rows[0]?metadata(rows[0]):null,versions:rows.map(metadata)};}
export async function prepExportStatus(env:Env,userId:number,appId:number,id:string){
 const row=await first(env,`${exportQuery} WHERE e.id=? AND e.application_id=? AND e.user_id=?`,id,appId,userId);if(!row)throw new ApiError(404,'Guide export not found');return metadata(row);
}
export async function downloadPrepExport(env:Env,userId:number,appId:number,id:string,format:'html'|'pdf'){
 const row=await first(env,`${exportQuery} WHERE e.id=? AND e.application_id=? AND e.user_id=?`,id,appId,userId);if(!row)throw new ApiError(404,'Guide export not found');
 const meta=metadata(row);if(meta.state==='expired')throw new ApiError(410,expired);if(meta.state!=='ready')throw new ApiError(409,meta.failure_reason||'The guide export is still being prepared. Refresh shortly.');
 const object=await files(env).get(format==='pdf'?row.pdf_key:row.html_key);if(!object)throw new ApiError(404,'This private export file is no longer available. Create a new export version.');
 return new Response(object.body,{headers:{'Content-Type':format==='pdf'?'application/pdf':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`${format==='pdf'?'attachment':'inline'}; filename="${appId}_prep_guide_v${row.version}.${format}"`,'X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'",'X-HireFlow-Export-Stale':String(meta.stale)}});
}
async function cleanup(env:Env,row:Row){await files(env).delete(row.html_key);await files(env).delete(row.pdf_key);}
export async function processPrepExport(env:Env,id:string){
 const now=new Date().toISOString(),row=await first(env,"UPDATE prep_guide_exports SET state='running',started_at=? WHERE id=? AND state='queued' AND work_expires_at>? AND expires_at>? RETURNING *",now,id,now,now);
 if(!row)return;
 try{
  const current=await first(env,`${exportQuery} WHERE e.id=?`,id);if(!current||bindingChanged(current))throw new ApiError(409,changed);
  const document=prepDocument(parsed(row.input_snapshot,{}),row.version,now),html=prepHtml(document),pdf=prepPdf(document);
  await files(env).put(row.html_key,html,{httpMetadata:{contentType:'text/html; charset=utf-8'}});await files(env).put(row.pdf_key,pdf,{httpMetadata:{contentType:'application/pdf'}});
  const finished=new Date().toISOString();
  const saved=await run(env,`UPDATE prep_guide_exports SET state='ready',finished_at=?,input_snapshot='{}' WHERE id=? AND state='running' AND work_expires_at>? AND EXISTS(
   SELECT 1 FROM applications a JOIN users u ON u.id=a.user_id JOIN jobs j ON j.id=a.job_id JOIN prep_guides g ON g.application_id=a.id WHERE a.id=? AND a.user_id=? AND u.profile_version=? AND g.id=? AND g.revision=? AND ${currentJobVersion}=?)`,finished,id,finished,row.application_id,row.user_id,row.profile_version,row.guide_id,row.guide_revision,row.job_version);
  if(!saved.meta.changes)throw new ApiError(409,changed);
 }catch(error){await cleanup(env,row);const reason=error instanceof ResumeFormatError?'The guide contains unsupported or excessive PDF content. Review the saved guide; no content was discarded.':error instanceof ApiError&&error.status===409?changed:unavailable;await run(env,"UPDATE prep_guide_exports SET state='failed',failure_reason=?,finished_at=?,input_snapshot='{}' WHERE id=? AND state='running'",reason,new Date().toISOString(),id);}
}
export async function recoverPrepExports(env:Env){
 const now=new Date().toISOString();
 await run(env,"UPDATE prep_guide_exports SET state='failed',failure_reason=?,finished_at=?,input_snapshot='{}' WHERE state IN ('queued','running') AND work_expires_at<=?",'Guide export timed out. Create a new export; the saved guide is unchanged.',now,now);
 await run(env,"UPDATE prep_guide_exports SET state='expired',failure_reason=?,input_snapshot='{}' WHERE state='ready' AND expires_at<=?",expired,now);
 const terminal=await all(env,"SELECT * FROM prep_guide_exports WHERE state IN ('failed','expired') AND cleaned_at IS NULL ORDER BY created_at LIMIT 3");for(const row of terminal){await cleanup(env,row);await run(env,"UPDATE prep_guide_exports SET cleaned_at=? WHERE id=? AND state IN ('failed','expired')",now,row.id);}
 const queued=await all(env,"SELECT * FROM prep_guide_exports WHERE state='queued' AND dispatched_at IS NULL AND work_expires_at>? ORDER BY created_at LIMIT 3",now);for(const row of queued)await dispatch(env,row);
}
/** Internal helper: storage keys are for the authorized report/email worker only. */
export async function latestPrepGuideExports(env:Env,userId:number,applicationIds:number[]){
 const ids=[...new Set(applicationIds.filter(Number.isSafeInteger))].slice(0,100),now=new Date().toISOString();if(!ids.length)return[];
 const rows=await all(env,`${exportQuery} WHERE e.user_id=? AND e.application_id IN (SELECT value FROM json_each(?)) AND e.state='ready' AND e.expires_at>?
  AND e.version=(SELECT MAX(newer.version) FROM prep_guide_exports newer WHERE newer.user_id=e.user_id AND newer.application_id=e.application_id AND newer.state='ready' AND newer.expires_at>?) ORDER BY e.application_id LIMIT 100`,userId,JSON.stringify(ids),now,now),seen=new Set<number>();
 return rows.flatMap(row=>{if(seen.has(row.application_id))return[];seen.add(row.application_id);return[{...metadata(row),html_key:row.html_key,pdf_key:row.pdf_key}];});
}
