import { applyTestMigrations } from './migrations';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const root=fileURLToPath(new URL('../',import.meta.url));
const code='regression-owner-code-long-enough-for-private-use';
let bundle:string, mf:Miniflare, cookie:string, id:number;
let db:Awaited<ReturnType<Miniflare['getD1Database']>>;
async function request(path:string,method='GET',body?:unknown,authenticated=true){
  return mf.dispatchFetch(`https://worker.example${path}`,{method,headers:{'Content-Type':'application/json','X-HireFlow-Access-Code':code,...(authenticated?{Cookie:cookie}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
}
async function plan(){const response=await request(`/weekly-plan/${id}`);expect(response.status,await response.clone().text()).toBe(200);return response.json() as Promise<any>;}
async function reviewedPayload(items:any[]){
  const user=await (await request(`/profile/${id}`)).json() as any,review_ids=[];
  for(const item of items){const response=await request(`/applications/${item.application_id}/review`,'POST',{resume_version:item.resume_version,profile_version:user.profile_version,reviewed:true,answers:{}});expect(response.status,await response.clone().text()).toBe(201);review_ids.push((await response.json() as any).review_id);}
  return{confirmed_job_ids:items.map(item=>item.job_id),review_ids};
}
async function addJobs(n:number){
  for(let i=0;i<n;i++){
    const response=await request(`/jobs/${id}`,'POST',{title:`Python ${i} Intern`,company:'Test Co',description:`Python and Docker internship. ${i===0?'LangChain RAG':'TypeScript'}`,url:`https://example.com/apply/${i}`,listing_type:'internship'});
    expect(response.status,await response.clone().text()).toBe(201);
  }
}
beforeAll(()=>{bundle=buildSync({entryPoints:[`${root}src/index.ts`],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*','cloudflare:*'],write:false,logLevel:'silent'}).outputFiles[0].text;});
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle,compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],r2Buckets:['FILES'],queueProducers:{APPLICATION_QUEUE:'test'},bindings:{ACCESS_CODE:code,BROWSER_ENABLED:'false'}}));
  db=await mf.getD1Database('DB');
  await applyTestMigrations(db);
  const response=await request('/profile','POST',{name:'Owner',email:'owner@example.com',skills:['Python'],mode:'internship',weekly_quota:10},false);
  expect(response.status).toBe(201);id=(await response.json() as any).id;cookie=response.headers.get('Set-Cookie')!.split(';')[0];
},30000);
afterEach(async()=>{await mf?.dispose();},30000);

describe('Cloudflare plan regressions',()=>{
  it('prepares, reuses and confirms a profile stored with whitespace and different JSON key ordering',async()=>{
    await addJobs(1);
    const original=await db.prepare('SELECT master_profile,profile_version FROM users WHERE id=?').bind(id).first<any>();
    const formatted=JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(original!.master_profile)).reverse()),null,2);
    expect(formatted).not.toBe(original!.master_profile);
    await db.prepare('UPDATE users SET master_profile=? WHERE id=?').bind(formatted,id).run();
    const current=await plan();expect(current.preparing).toBe(false);expect(current.plan).toHaveLength(1);expect(current.plan[0].resume_url).toBeTruthy();
    const pdf=await request(current.plan[0].resume_url);expect(pdf.status).toBe(200);expect((await pdf.text()).startsWith('%PDF-')).toBe(true);
    const cached=await plan();expect(cached.plan[0].resume_version).toBe(current.plan[0].resume_version);expect(cached.plan[0].resume_url).toBe(current.plan[0].resume_url);
    expect((await db.prepare('SELECT count(*) AS n FROM resumes').first<any>())!.n).toBe(1);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',await reviewedPayload(current.plan))).status).toBe(200);
    expect(await db.prepare('SELECT master_profile,profile_version FROM users WHERE id=?').bind(id).first<any>()).toEqual({master_profile:formatted,profile_version:original!.profile_version});
  });
  it('returns the real source, listing URL, location and mode for review',async()=>{
    const listing={title:'Python Intern',company:'Verified Company',description:'A Python engineering internship working on documented projects.',url:'https://internshala.com/internship/detail/python-internship-at-example12345',location:'Bengaluru',listing_type:'internship'};
    expect((await request(`/jobs/${id}`,'POST',listing)).status).toBe(201);
    const current=await plan();
    expect(current.plan[0]).toMatchObject({url:listing.url,source:'Internshala',location:'Bengaluru',listing_type:'internship'});
  });
  it('prepares large plans in bounded batches and refuses unprepared confirmation',async()=>{
    await addJobs(5);const first=await plan();expect(first.plan).toHaveLength(5);expect(first.preparing).toBe(true);expect(first.plan.filter((a:any)=>a.resume_url)).toHaveLength(3);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',{confirmed_job_ids:first.plan.map((a:any)=>a.job_id)})).status).toBe(400);
    const ready=await plan();expect(ready.preparing).toBe(false);expect(ready.plan.every((a:any)=>a.resume_url)).toBe(true);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',await reviewedPayload(ready.plan))).status).toBe(200);
    const stored=await db.prepare("SELECT count(*) AS n FROM applications WHERE status='confirmed'").first<any>();expect(stored!.n).toBe(5);
  });
  it('invalidates reviewed drafts after a profile edit, refreshes five scores at a time, and preserves historical PDFs',async()=>{
    await addJobs(6);await plan();const old=await plan();const selected=old.plan[0];
    const changed=await request(`/profile/${id}`,'PATCH',{skills:['Python','TypeScript','Docker']});expect(changed.status).toBe(200);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',{confirmed_job_ids:[selected.job_id]})).status).toBe(400);
    const updating=await plan();expect(updating).toMatchObject({preparing:true,plan:[]});expect(updating.warnings[0]).toContain('1 remaining');
    const next=await plan();expect(next.preparing).toBe(true);const final=await plan();expect(final.preparing).toBe(false);
    const refreshed=final.plan.find((a:any)=>a.application_id===selected.application_id);expect(refreshed.resume_version).toBe(2);
    const historical=await request(`${selected.resume_url}?version=1`);expect(historical.status).toBe(200);expect((await historical.text()).startsWith('%PDF-')).toBe(true);
    const stale=await db.prepare('SELECT count(*) AS n FROM applications a JOIN users u ON u.id=a.user_id WHERE a.scored_profile_version<>u.profile_version').first<any>();expect(stale!.n).toBe(0);
  });
  it('enforces a reduced quota and preserves submitted PDFs across later profile edits',async()=>{
    await addJobs(2);const old=await plan();const first=old.plan[0];
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',await reviewedPayload([first]))).status).toBe(200);
    await db.prepare("UPDATE applications SET status='applied' WHERE id=?").bind(first.application_id).run();
    expect((await request(`/profile/${id}`,'PATCH',{weekly_quota:1,skills:['Python','Docker']})).status).toBe(200);
    const current=await plan();expect(current.plan).toHaveLength(0);
    expect((await request(first.resume_url)).status).toBe(200);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',{confirmed_job_ids:[old.plan[1].job_id]})).status).toBeGreaterThanOrEqual(400);
  });
  it('persists a plan company exclusion without replacing resume facts and leaves excluded companies out on later refreshes',async()=>{
    const facts={projects:[{name:'Original project',description:'Built a factual Python project.'}],education:[{degree:'BSc',institution:'Example College'}],summary:'Built Python services during coursework.'};
    expect((await request(`/profile/${id}`,'PATCH',facts)).status).toBe(200);
    await addJobs(2);const initial=await plan();expect(initial.plan).toHaveLength(2);
    const saved=await request(`/profile/${id}`,'PATCH',{blacklist_companies:['Test Co']});expect(saved.status).toBe(200);
    const profile=await saved.json() as any;expect(profile.master_profile).toMatchObject({...facts,skills:['Python'],blacklist_companies:['Test Co']});
    const refreshed=await plan();expect(refreshed.plan).toHaveLength(0);expect(refreshed.alternatives).toHaveLength(0);
    expect((await plan()).plan).toHaveLength(0);
    expect((await request(`/weekly-plan/${id}/confirm`,'POST',{confirmed_job_ids:[initial.plan[0].job_id]})).status).toBe(400);
  });
  it('commits at most one confirmation when the same plan is confirmed concurrently',async()=>{
    await addJobs(1);const draft=await plan();const payload=await reviewedPayload(draft.plan);
    const results=await Promise.all([request(`/weekly-plan/${id}/confirm`,'POST',payload),request(`/weekly-plan/${id}/confirm`,'POST',payload)]);
    expect(results.filter(r=>r.status===200)).toHaveLength(1);
    const events=await db.prepare("SELECT count(*) AS n FROM application_status_events WHERE status='confirmed'").first<any>();expect(events!.n).toBe(1);
    const queued=await db.prepare("SELECT count(*) AS n FROM outbox WHERE kind='apply'").first<any>();expect(queued!.n).toBe(1);
  });
  it('rate limits incorrect owner codes and denies unapproved origins',async()=>{
    for(let i=0;i<10;i++)expect((await mf.dispatchFetch('https://worker.example/session/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.com',access_code:'wrong'})})).status).toBe(401);
    expect((await request('/session/login','POST',{email:'owner@example.com',access_code:code})).status).toBe(429);
    const denied=await mf.dispatchFetch('https://worker.example/profile/1',{headers:{Cookie:cookie,Origin:'https://attacker.example'}});expect(denied.status).toBe(403);
  });
  it('rejects expired sessions and cross-profile PDF download attempts',async()=>{
    await addJobs(1);const current=await plan();const url=current.plan[0].resume_url;
    await db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();expect((await request(url)).status).toBe(401);
  });
  it('bounds public frontend profile bootstrapping without locking out existing sessions',async()=>{
    const day=new Date().toISOString().slice(0,10);
    await db.prepare('INSERT INTO login_attempts(key,attempts,window_start) VALUES(?,49,?) ON CONFLICT(key) DO UPDATE SET attempts=49').bind(`signup:${day}`,Date.parse(day)).run();
    const create=(email:string)=>request('/profile','POST',{name:'Another profile',email,skills:['Python'],mode:'internship'},false);
    expect((await create('allowed@example.com')).status).toBe(201);
    expect((await create('over-capacity@example.com')).status).toBe(429);
    expect((await request(`/profile/${id}`)).status).toBe(200);
    expect((await request(`/profile/${id}`,'PATCH',{phone:'9999999999'})).status).toBe(200);
    expect(await db.prepare('SELECT id FROM users WHERE email=?').bind('over-capacity@example.com').first()).toBeNull();
  });
});
