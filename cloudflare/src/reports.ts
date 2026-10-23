import { ApiError, type Env, type Row, parsed, weekStart } from './types';
import { all, first, run, userById, historicalListing } from './storage';
import { files, type FileObject } from './files';

const escape = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export async function latestReport(env: Env, userId: number): Promise<Row> {
  const report = await first(env, 'SELECT * FROM weekly_reports WHERE user_id=? ORDER BY week_start_date DESC,id DESC LIMIT 1', userId);
  if (!report) throw new ApiError(404, 'No weekly report generated yet');
  return { ...report, week_start: report.week_start_date, content: parsed(report.content, {}), metrics: parsed(report.metrics, {}), html_url: `/report/${userId}/latest/html` };
}
export async function generateReport(env: Env, userId: number) {
  const user = await userById(env, userId); const start = weekStart();
  const end = new Date(Date.parse(start) + 7 * 86400000).toISOString().slice(0, 10);
  // Matching already extracted JD skills. Reuse that cache rather than loading
  // and scanning every full description in a request with a 10 ms CPU budget.
  const rows = (await all(env, `SELECT a.id,a.job_snapshot,a.status,a.match_score,a.skill_gaps,a.matched_skills,a.failure_reason,a.manual_action_url,a.resume_path,j.title,j.company,j.listing_type,j.source,j.url,j.canonical_url,j.application_url,j.required_skills,j.required_experience,j.posted_date,j.expires_at,j.selection_process,j.compensation,j.provenance
    FROM applications a JOIN jobs j ON j.id=a.job_id WHERE a.user_id=? AND (a.cycle_start=? OR (a.applied_at>=? AND a.applied_at<?) OR (a.cycle_start IS NULL AND a.created_at>=? AND a.created_at<?)) ORDER BY a.match_score DESC,a.id`, userId, start, start, end, start, end)).map(historicalListing);
  const guides = await all(env, 'SELECT application_id FROM prep_guides WHERE application_id IN (SELECT value FROM json_each(?))', JSON.stringify(rows.map(row => row.id)));
  const guideIds = new Set(guides.map(guide => guide.application_id));
  const applications = rows.map(a => ({id:a.id,listing_type:a.listing_type,source:a.source,canonical_url:a.canonical_url||a.url,application_url:a.application_url||a.url,required_skills:parsed(a.required_skills,[]),required_experience:parsed(a.required_experience,null),posted_date:a.posted_date,expires_at:a.expires_at,selection_process:parsed(a.selection_process,[]),compensation:parsed<Row|null>(a.compensation,null),provenance:parsed(a.provenance,{}), company:a.company, role:a.title, status:a.status, match_score:a.match_score, skill_gaps:parsed(a.skill_gaps, []), failure_reason:a.failure_reason, manual_action_url:a.manual_action_url,
    resume_url:a.resume_path ? `/resumes/${userId}/${a.id}/download` : null, prep_guide_url:guideIds.has(a.id) ? `/applications/${a.id}/prep-guide` : null }));
  const frequencies = new Map<string, number>(); const gapCounts = new Map<string, number>();
  const skills = (value: unknown): string[] => { const result = parsed<unknown>(value, []); return Array.isArray(result) ? result.filter((skill): skill is string => typeof skill === 'string' && Boolean(skill)) : []; };
  for (const row of rows) {
    for (const skill of new Set([...skills(row.matched_skills), ...skills(row.skill_gaps)])) frequencies.set(skill, (frequencies.get(skill) || 0) + 1);
    for (const gap of new Set(skills(row.skill_gaps))) gapCounts.set(gap, (gapCounts.get(gap) || 0) + 1);
  }
  const ranked = (map: Map<string,number>, n: number) => [...map].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,n).map(([skill,frequency])=>({skill,frequency}));
  const types = new Map<string, number[]>();
  rows.forEach(r => { const values = types.get(r.listing_type) || []; values.push(r.match_score); types.set(r.listing_type, values); });
  const averages = [...types].map(([type,scores])=>({type,score:scores.reduce((a,b)=>a+b,0)/scores.length})).sort((a,b)=>b.score-a.score);
  const topSkills = ranked(frequencies,5); const studyPlan = ranked(gapCounts,3);
  const modes=['internship','job'].map(type=>{const members=rows.filter(row=>row.listing_type===type);return {listing_type:type,total_applications:members.length,applied_count:members.filter(row=>row.status==='applied').length,average_match_score:members.length?members.reduce((sum,row)=>sum+row.match_score,0)/members.length:null};});
  const metrics = {quota_policy:'shared_across_modes_per_UTC_week',mode_summaries:modes,top_skills:topSkills,strongest_match_type:averages[0]?.type || null,weakest_match_type:averages.at(-1)?.type || null,study_plan:studyPlan,total_applications:rows.length};
  const appliedCount = rows.filter(r=>r.status==='applied').length;
  const avgScore = rows.length ? rows.reduce((sum,r)=>sum+r.match_score,0)/rows.length : 0;
  const content = {applications,mode_groups:modes.map(mode=>({...mode,applications:applications.filter(app=>app.listing_type===mode.listing_type)})),insights:metrics,study_plan:studyPlan,week_start:start};
  const base = (env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const dashboard = base.endsWith('/api') ? base.slice(0, -4) : base;
  const link = (path: string | null, text: string, dashboardRoute = false) => path ? `<a href="${escape((dashboardRoute ? dashboard : base) + path)}">${text}</a>` : 'Preparing';
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>HireFlow weekly report</title><style>body{font:16px/1.6 system-ui;max-width:960px;margin:32px auto;padding:0 20px;color:#173d34}article{border:1px solid #cbd8d3;padding:20px;margin:18px 0;border-radius:12px}.action{border-left:5px solid #c5701f}a{color:#14664c}</style><h1>${escape(user.name)}'s weekly report</h1><p>Week of ${start}. ${appliedCount} applied. Average match ${Math.round(avgScore*100)}%.</p><h2>Across your applications</h2><p>Top skills: ${topSkills.map(s=>`${escape(s.skill)} (${s.frequency})`).join(', ') || 'No jobs this week'}.</p><p>Strongest match type: ${escape(metrics.strongest_match_type || 'Not enough data')}. Weakest match type: ${escape(metrics.weakest_match_type || 'Not enough data')}.</p><h2>This week's study plan</h2><ol>${studyPlan.map(s=>`<li>${escape(s.skill)} — appears as a gap in ${s.frequency} job descriptions. Read the documentation and build one small example.</li>`).join('')}</ol><h2>Modes this week</h2><p>Internship and Job share one weekly quota; switching modes does not reset submitted/attempted usage.</p><ul>${modes.map(mode=>`<li>${mode.listing_type}: ${mode.total_applications} opportunities, ${mode.applied_count} applied</li>`).join('')}</ul><h2>Applications</h2>${applications.map(a=>`<article class="${['failed','needs_action'].includes(a.status)?'action':''}"><h3>${escape(a.company)} — ${escape(a.role)}</h3><p>${escape(a.listing_type)} · ${escape(a.status)} · ${Math.round(a.match_score*100)}% match</p><p>Source: ${escape(a.source||'Not recorded')}. ${a.compensation?.disclosed?`Pay: ${escape(a.compensation.currency||'Currency unspecified')} ${escape(a.compensation.minimum??'')}–${escape(a.compensation.maximum??'')} / ${escape(a.compensation.period||'period unspecified')}.`:'Pay not disclosed.'}</p><p>${link(a.resume_url,'Resume PDF')} · ${link(a.prep_guide_url,'Prep guide',true)}</p>${a.failure_reason?`<p>${escape(a.failure_reason)}</p>`:''}${a.status==='needs_action'&&a.manual_action_url?`<p>Next step: <a rel="noopener noreferrer" href="${escape(a.manual_action_url)}">open the employer application</a>, check whether it was already submitted, then complete any remaining action.</p>`:a.status==='failed'?'<p>Next step: review the failure reason and apply directly on the employer site.</p>':''}</article>`).join('')}</html>`;
  // KV caches immutable versions; the D1 row selects the latest report key.
  const key = `reports/${userId}/week_${start}_${crypto.randomUUID()}.html`;
  await files(env).put(key, html, {httpMetadata:{contentType:'text/html; charset=utf-8'}});
  await run(env, `INSERT INTO weekly_reports(user_id,week_start_date,content,metrics,applied_count,avg_match_score,html_path) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(user_id,week_start_date) DO UPDATE SET content=excluded.content,metrics=excluded.metrics,applied_count=excluded.applied_count,avg_match_score=excluded.avg_match_score,html_path=excluded.html_path`,
    userId,start,JSON.stringify(content),JSON.stringify(metrics),appliedCount,avgScore,key);
  return latestReport(env,userId);
}

export async function emailReport(env: Env, userId: number) {
  const user = await userById(env,userId); const report = await latestReport(env,userId);
  const object = await files(env).get(report.html_path);
  if (!object) throw new ApiError(404,'Report HTML is missing');
  const provider = env.EMAIL_PROVIDER || 'resend';
  const key = provider==='resend'?env.RESEND_API_KEY:env.SENDGRID_API_KEY;
  if (!['resend','sendgrid'].includes(provider) || !key || !env.FROM_EMAIL || env.FROM_EMAIL==='hireflow@example.com') throw new ApiError(503,'Configure the email provider key and a verified FROM_EMAIL');
  const ids = report.content.applications.map((a:Row)=>a.id);
  const rows = await all(env,'SELECT id,resume_path,resume_version,job_id FROM applications WHERE user_id=? AND id IN (SELECT value FROM json_each(?)) AND resume_path IS NOT NULL LIMIT 10',userId,JSON.stringify(ids));
  const attachmentsFiles: (Row & {object:FileObject|null})[] = await Promise.all(rows.map(async a => ({...a,object:await files(env).get(a.resume_path)})));
  // Keep encoding work and request memory bounded well below either provider's
  // message limit. Private links require signing in; they are never made public.
  let total = 0; const attachments: {filename:string;content:string;type:string;disposition:string}[] = []; const links:string[]=[];
  for (const file of attachmentsFiles) {
    if (!file.object) continue;
    const name=`${file.job_id}_resume_v${file.resume_version}.pdf`;
    if (total+file.object.size>128*1024) {
      links.push(`<li><a href="${escape((env.PUBLIC_BASE_URL||'').replace(/\/$/,'')+`/resumes/${userId}/${file.id}/download`)}">${name}</a> (sign in to download)</li>`); continue;
    }
    total+=file.object.size;
    const bytes = new Uint8Array(await file.object.arrayBuffer());
    let binary=''; for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    attachments.push({filename:name,content:btoa(binary),type:'application/pdf',disposition:'attachment'});
  }
  const html=await object.text()+(links.length?`<p>Additional resumes are available in your private workspace:</p><ul>${links.join('')}</ul>`:'');
  const payload = provider==='resend'?{from:env.FROM_EMAIL,to:[user.email],subject:`HireFlow — week of ${report.week_start}`,html,attachments:attachments.map(a=>({filename:a.filename,content:a.content}))}:
    {personalizations:[{to:[{email:user.email}]}],from:{email:env.FROM_EMAIL},subject:`HireFlow — week of ${report.week_start}`,content:[{type:'text/html',value:html}],attachments};
  try {
    const response=await fetch(provider==='resend'?'https://api.resend.com/emails':'https://api.sendgrid.com/v3/mail/send',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error();
    await run(env,'UPDATE weekly_reports SET email_sent_at=?,email_failure_reason=NULL WHERE id=?',new Date().toISOString(),report.id);
    return {status:'sent',attachments:attachments.length,linked_resumes:links.length};
  } catch {
    await run(env,'UPDATE weekly_reports SET email_failure_reason=? WHERE id=?','Email provider did not confirm delivery',report.id);
    throw new ApiError(503,'Email provider did not confirm delivery. Check your provider dashboard before retrying.');
  }
}
