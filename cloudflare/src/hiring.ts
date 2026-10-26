/** Private hiring reports. Candidate declarations are evidence, not verified proficiency. */
import {ApiError,type Env,type Row,parsed} from './types';
import {scoreMatch,canonicalSkill} from './intelligence';
import {first,all,run} from './storage';
import {digest} from './auth';
import {validatePublicUrl} from './public_url';

const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
const fail=(field:string):never=>{throw new ApiError(422,`Invalid ${field}. Use the documented bounded applicant schema.`);};
function string(value:unknown,field:string,max=1200,optional=true):string {
 if(value==null||value===''){if(optional)return '';return fail(field);}
 if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))return fail(field);
 const text=value.trim();if(!optional&&!text)return fail(field);return text;
}
function strings(value:unknown,field:string,max=40):string[]{
 if(value==null||value==='')return [];
 if(!Array.isArray(value)||value.length>max)return fail(field);
 return [...new Set(value.map(item=>string(item,field,120,false)))];
}
function jsonColumn(value:unknown,field:string):unknown {if(typeof value!=='string'||!value.trim())return value||[];try{return JSON.parse(value);}catch{return fail(field+' CSV JSON column');}}
export function parseHiringCsv(csv:string):Row[]{
 const rows:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
 for(let i=0;i<csv.length;i++){
  const c=csv[i];
  if(c==='"'){if(quoted&&csv[i+1]==='"'){cell+='"';i++;}else if(!quoted&&cell.trim())return fail('CSV quoting');else{quoted=!quoted;if(!quoted)closed=true;}}
  else if(!quoted&&(c===','||c==='\n')){row.push(cell.trim());cell='';closed=false;if(c==='\n'){rows.push(row);row=[];}}
  else if(c!=='\r'){if(closed&&c.trim())return fail('CSV quoting');cell+=c;}
 }
 if(quoted)return fail('CSV quoting');if(cell||row.length){row.push(cell.trim());rows.push(row);}
 const headers=rows.shift()||[];if(!headers.includes('name')||new Set(headers).size!==headers.length||headers.length>30)return fail('CSV header');
 return rows.filter(row=>row.some(Boolean)).map(row=>{
  if(row.length!==headers.length)return fail('CSV row width');
  const item:Row=Object.fromEntries(headers.map((key,i)=>[key,row[i]]));
  item.skills=(item.skills||'').split(/[;,|]/).map((s:string)=>s.trim()).filter(Boolean);
  for(const field of ['projects','experience','education','target_roles','preferred_locations'])if(item[field])item[field]=jsonColumn(item[field],field);
  if(Object.hasOwn(item,'experience_years')&&item.experience_years!=='')item.experience_years=Number(item.experience_years);else delete item.experience_years;
  return item;
 });
}
function facts(value:unknown,field:'projects'|'experience'|'education'):Row[]{
 if(value==null||value==='')return [];
 if(field==='education'&&typeof value==='string')return [{degree:string(value,field,2000)}];
 if(!Array.isArray(value)||value.length>8)return fail(field);
 return value.map((item,index)=>{
  if(!item||typeof item!=='object'||Array.isArray(item))return fail(field);
  const output:Row={};const allowed=field==='projects'?['name','description','url']:field==='experience'?['role','company','description','start_date','end_date']:['degree','institution','field','graduation_year'];
  for(const key of allowed)if(item[key]!=null){const raw=typeof item[key]==='number'&&key==='graduation_year'?String(item[key]):item[key];output[key]=string(raw,`${field}[${index}].${key}`,key==='description'?2000:300);}
  if(field==='projects'&&output.url){try{output.url=validatePublicUrl(output.url);}catch{return fail('project public URL');}}
  if(field!=='education')output.technologies=strings(item.technologies??item.skills,`${field}[${index}].technologies`,30);
  if(!Object.values(output).some(value=>typeof value==='string'&&value))return fail(field);
  return output;
 });
}
export function normalizeHiringInput(data:Row):Row {
 const jd=string(data.jd_text,'job description',30000,false);
 if(bytes(data.applicants)>128*1024)throw new ApiError(413,'The applicant pool exceeds 128 KiB. Split it into smaller private batches.');
 const pool=typeof data.applicants==='string'?parseHiringCsv(data.applicants):data.applicants;
 if(!Array.isArray(pool)||pool.length>200)return fail('applicant pool (maximum 200)');
 const size=data.shortlist_size??20;if(!Number.isSafeInteger(size)||size<1||size>200)return fail('shortlist_size (1–200)');
 const applicants=pool.map((raw,index)=>{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail(`applicant ${index+1}`);
  const profile:Row={name:string(raw.name,'applicant name',200,false),skills:strings(raw.skills,'skills'),projects:facts(raw.projects,'projects'),experience:facts(raw.experience,'experience'),education:facts(raw.education,'education'),target_roles:strings(raw.target_roles,'target_roles',10),preferred_locations:strings(raw.preferred_locations,'preferred_locations',10)};
  if(raw.experience_years!=null&&raw.experience_years!==''){if(typeof raw.experience_years!=='number'||!Number.isFinite(raw.experience_years)||raw.experience_years<0||raw.experience_years>60)return fail('experience_years (0–60)');profile.experience_years=raw.experience_years;}
  return profile;
 });
 const input={jd_text:jd,title:string(data.title,'job title',300),listing_type:data.listing_type==='internship'||data.listing_type==='job'?data.listing_type:/\bintern(?:ship)?\b/i.test(jd)?'internship':'job',shortlist_size:size,applicants};
 if(bytes(input)>160*1024)throw new ApiError(413,'The normalized hiring input exceeds the private batch limit.');return input;
}
const weights={skill_match:.4,role_fit:.2,experience_fit:.15,location_match:.1,compensation_fit:.1,company_signal:.05};
export function buildHiringReport(input:Row,createdAt=new Date().toISOString()):Row {
 const job={title:input.title||'',description:input.jd_text,listing_type:input.listing_type};
 const ranked=input.applicants.map((profile:Row,index:number)=>{
  const evidence:Row[]=[];for(const [position,skill]of profile.skills.entries())evidence.push({skill,kind:'declared_skill',source_path:`applicants[${index}].skills[${position}]`,quote:skill});
  for(const field of ['projects','experience'])for(const [position,fact]of profile[field].entries())for(const [n,skill]of fact.technologies.entries())evidence.push({skill,kind:'explicit_technology',source_path:`applicants[${index}].${field}[${position}].technologies[${n}]`,quote:skill,context:fact.name||fact.role||fact.description});
  const supplied=[...new Map(evidence.map(item=>[item.skill.toLowerCase(),item.skill])).values()];
  const match=scoreMatch({...profile,skills:supplied,mode:input.listing_type},job);
  return {name:profile.name,applicant_index:index,score:match.score,matched_skills:match.matched,skill_matches:match.matched,skill_gaps:match.gaps,factor_scores:match.factors,
   factor_explanations:Object.entries(match.factors).map(([factor,score])=>({factor,score,weight:weights[factor as keyof typeof weights],basis:factor==='skill_match'?'Explicitly declared skills and project/experience technologies only.':factor==='experience_fit'?(profile.experience_years==null?'Years were not supplied; the shared scorer receives its documented zero-years default.':'Applicant-reported years compared with explicit JD requirements.'):factor==='role_fit'?'Applicant-supplied target roles; missing preferences use the shared neutral default.':factor==='location_match'?'No inferred residence or nationality; missing listing location is neutral.':factor==='compensation_fit'?'Missing compensation preferences are neutral.':'Missing employer identity uses the same listing-evidence default as candidate matching.'})),
   evidence:match.matched.map(skill=>({skill,sources:evidence.filter(item=>canonicalSkill(item.skill).toLowerCase()===skill.toLowerCase())})),facts:{experience_years:profile.experience_years??null,projects:profile.projects,experience:profile.experience,education:profile.education},
   review_notes:[...(profile.experience_years==null?['Experience years were not supplied; verify before making a hiring decision.']:[]),...(!profile.projects.length?['No project evidence supplied.']:[]),...(!profile.education.length?['No education evidence supplied.']:[]),'Applicant declarations and technology mentions do not verify proficiency, ownership or credentials.']};
 }).sort((a:Row,b:Row)=>b.score-a.score||a.applicant_index-b.applicant_index);
 const selected=ranked.filter((row:Row)=>row.matched_skills.length).slice(0,input.shortlist_size);
 return {schema_version:'hiring-evidence-v1',created_at:createdAt,title:input.title||'Hiring shortlist',listing_type:input.listing_type,jd_text:input.jd_text,shortlist:selected,candidates:ranked,applicant_count:ranked.length,shortlisted_count:selected.length,summary:`Selected ${selected.length} of ${ranked.length} applicants with at least one explicit matching skill.`,scoring_method:'shared_six_factor_lexical',factor_weights:weights,decision_policy:'Decision support only. Scores are not hiring probabilities. Verify declarations and review every candidate before a human hiring decision.',excluded_inputs:'Name is for display only. Age, gender, religion, caste, ethnicity, disability, photos and other unrelated fields are excluded from scoring and from this stored snapshot.'};
}
const escape=(value:unknown)=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function renderHiringHtml(report:Row):string {
 const items=(report.candidates||report.shortlist||[]).map((candidate:Row)=>`<article><h2>${escape(candidate.applicant_index+1)}. ${escape(candidate.name)} — ${Math.round(candidate.score*100)}%</h2><p>${(report.shortlist||[]).some((item:Row)=>item.applicant_index===candidate.applicant_index)?'Shortlisted for human review':'Outside the requested shortlist'}</p><p>Matched: ${escape((candidate.matched_skills||candidate.skill_matches||[]).join(', ')||'None')}. Gaps: ${escape((candidate.skill_gaps||[]).join(', ')||'None identified')}.</p><h3>Score factors</h3><ul>${(candidate.factor_explanations||[]).map((f:Row)=>`<li>${escape(f.factor)}: ${Number(f.score).toFixed(2)} × ${f.weight} — ${escape(f.basis)}</li>`).join('')}</ul><h3>Applicant facts</h3><pre>${escape(JSON.stringify(candidate.facts||{},null,2))}</pre><h3>Skill evidence</h3><pre>${escape(JSON.stringify(candidate.evidence||[],null,2))}</pre><ul>${(candidate.review_notes||[]).map((note:string)=>`<li>${escape(note)}</li>`).join('')}</ul></article>`).join('');
 return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(report.title||'Hiring shortlist')}</title><style>body{font:16px/1.6 system-ui;max-width:980px;margin:32px auto;padding:0 20px;color:#173d34}article{border-top:1px solid #cad8d0;padding:20px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#f4f7f5;padding:12px}h2{line-height:1.3}</style><h1>${escape(report.title||'Hiring shortlist')}</h1><p>${escape(report.summary)}</p><p>Generated ${escape(report.created_at)}. Method: ${escape(report.scoring_method)}.</p><p>${escape(report.decision_policy)}</p><p>${escape(report.excluded_inputs)}</p><details><summary>Original job description</summary><pre>${escape(report.jd_text)}</pre></details>${items||'<p>No candidates have an explicit matching skill.</p>'}</html>`;
}
async function owned(env:Env,owner:number,id:number){const row=await first(env,'SELECT * FROM shortlists WHERE id=? AND user_id=?',id,owner);if(!row)throw new ApiError(404,'Hiring report not found');return row;}
function metadata(row:Row){return{id:row.id,state:row.state,created_at:row.created_at,completed_at:row.completed_at,applicant_count:row.applicant_count,failure_reason:row.failure_reason,report_hash:row.report_hash,score_attempts:row.score_attempts,status_url:`/hiring/shortlists/${row.id}`,html_url:row.state==='completed'?`/hiring/shortlists/${row.id}/report.html`:null};}
async function dispatch(env:Env,row:Row){try{await env.APPLICATION_QUEUE.send({kind:'hiring_score',shortlist_id:row.id});await run(env,"UPDATE shortlists SET dispatched_at=? WHERE id=? AND state='queued'",new Date().toISOString(),row.id);}catch{/* Durable pending work is recovered by maintenance. */}}
export async function createShortlist(env:Env,owner:number,data:Row){
 const input=normalizeHiringInput(data),counts=await first(env,"SELECT count(*) AS total,sum(CASE WHEN state IN ('queued','running') THEN 1 ELSE 0 END) AS active FROM shortlists WHERE user_id=?",owner);
 if(Number(counts?.active||0)>=3||Number(counts?.total||0)>=100)throw new ApiError(409,'A workspace can retain100 hiring reports and prepare at most3 at a time. Wait for pending reports before requesting another.');
 const day=new Date().toISOString().slice(0,10),reserved=await first(env,`INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET attempts=attempts+1 WHERE attempts<20 RETURNING attempts`,`hiring-report:${day}`,Date.parse(day));
 if(!reserved)throw new ApiError(429,'The free deployment hiring-report allowance is reached. Existing reports are preserved; try again after the UTC day changes.');
 const result=await run(env,`INSERT INTO shortlists(user_id,jd_text,candidates,applicant_count,state,input_snapshot) SELECT ?,?,'[]',?,'queued',? WHERE NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=? AND state IN ('queued','deleting')) AND (SELECT count(*) FROM shortlists WHERE user_id=?)<100 AND (SELECT count(*) FROM shortlists WHERE user_id=? AND state IN ('queued','running'))<3`,owner,input.jd_text,input.applicants.length,JSON.stringify(input),owner,owner,owner);
 if(!result.meta.changes)throw new ApiError(409,'The workspace changed or its report limit was reached. Wait for pending work before requesting another.');const id=Number(result.meta.last_row_id);
 if(env.PLAN_WORK_IN_QUEUE==='true')await dispatch(env,{id});else await processHiringShortlist(env,id);
 return getShortlist(env,owner,id);
}
export async function processHiringShortlist(env:Env,id:number){
 const token=crypto.randomUUID(),now=new Date().toISOString();
 const row=await first(env,`UPDATE shortlists SET state='running',score_attempts=score_attempts+1,lease_token=?,lease_expires_at=? WHERE id=? AND state IN ('queued','running') AND score_attempts<3 AND (lease_expires_at IS NULL OR lease_expires_at<=?) AND NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=shortlists.user_id AND state IN ('queued','deleting')) RETURNING *`,token,new Date(Date.now()+120000).toISOString(),id,now);if(!row)return;
 try{const input=normalizeHiringInput(parsed(row.input_snapshot,{})),report=buildHiringReport(input),html=renderHiringHtml(report),hash=await digest(html);if(bytes(report)>900000||new TextEncoder().encode(html).length>900000)throw new Error('bounds');
  await run(env,`UPDATE shortlists SET state='completed',candidates=?,report_data=?,report_html=?,report_hash=?,completed_at=?,failure_reason=NULL,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND lease_token=? AND lease_expires_at>? AND NOT EXISTS(SELECT 1 FROM workspace_deletions WHERE user_id=shortlists.user_id AND state IN ('queued','deleting'))`,JSON.stringify(report.shortlist),JSON.stringify(report),html,hash,new Date().toISOString(),id,token,new Date().toISOString());
 }catch{await run(env,"UPDATE shortlists SET state='failed',failure_reason='This bounded hiring report could not be prepared. Check applicant fields and split larger pools into smaller batches.',lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?",id,token);}
}
export async function recoverHiringShortlists(env:Env){const now=new Date().toISOString();await run(env,"UPDATE shortlists SET state='failed',failure_reason='Hiring report preparation stopped after three interrupted attempts. Create a fresh smaller batch after reviewing the input.',lease_token=NULL,lease_expires_at=NULL WHERE state='running' AND score_attempts>=3 AND lease_expires_at<=?",now);const rows=await all(env,"SELECT id FROM shortlists WHERE score_attempts<3 AND ((state='queued' AND (dispatched_at IS NULL OR dispatched_at<?)) OR (state='running' AND lease_expires_at<=?)) ORDER BY id LIMIT 3",new Date(Date.now()-300000).toISOString(),now);for(const row of rows){await run(env,"UPDATE shortlists SET state='queued',lease_token=NULL,lease_expires_at=NULL WHERE id=? AND state='running' AND lease_expires_at<=?",row.id,now);await dispatch(env,row);}}
export async function getShortlist(env:Env,owner:number,id:number){const row=await owned(env,owner,id),report=parsed<Row>(row.report_data,{});return{...metadata(row),...(row.state==='completed'?(report.schema_version?report:{shortlist:parsed(row.candidates,[]),summary:'Legacy shortlist: extended evidence was not recorded.',legacy:true}):{})};}
export async function listShortlists(env:Env,owner:number,page=1,pageSize=20){if(!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>50)throw new ApiError(422,'Use positive page and page_size up to 50.');const rows=await all(env,'SELECT id,state,created_at,completed_at,applicant_count,failure_reason,report_hash FROM shortlists WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?',owner,pageSize,(page-1)*pageSize),total=await first(env,'SELECT count(*) AS n FROM shortlists WHERE user_id=?',owner);return{items:rows.map(metadata),total:total!.n,page,page_size:pageSize};}
export async function shortlistHtml(env:Env,owner:number,id:number){const row=await owned(env,owner,id);if(row.state!=='completed')throw new ApiError(409,'The hiring report is not ready.');const html=row.report_html||renderHiringHtml({...parsed<Row>(row.report_data,{}),shortlist:parsed(row.candidates,[]),summary:'Legacy shortlist: no extended source evidence was saved.'});return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",'Content-Disposition':`inline; filename="hireflow-shortlist-${id}.html"`}});}
