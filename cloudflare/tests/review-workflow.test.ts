import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { applyTestMigrations } from './migrations';
import type { Env } from '../src/types';
import { addJobs, confirmPlan, getPlan, swapPlan } from '../src/plans';
import { applicationQuery, dispatchOutbox, userById } from '../src/storage';
import { cancelQueuedApplication, createSubmissionReview, editResume, getValidSubmissionReview, regenerateResume, rejectResume, resumeDraft, reviewQuestions, validateSubmissionReview } from '../src/reviews';

vi.mock('@cloudflare/playwright', () => ({ launch: vi.fn() }));
let mf: Miniflare, env: Env;
let db: Awaited<ReturnType<Miniflare['getD1Database']>>, bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const profile = {name:'Review Candidate',email:'review@example.com',mode:'internship',skills:['Python'],summary:'Built Python tools for college coursework.',experience:[],projects:[{name:'Planner',description:'Built a Python task planner.',tech:['Python']}],education:'BTech Computer Science'};
beforeEach(async()=>{
  mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2026-10-21',d1Databases:['DB'],r2Buckets:['FILES']}));
  db=await mf.getD1Database('DB');bucket=await mf.getR2Bucket('FILES');await applyTestMigrations(db);
  env={DB:db,FILES:bucket,APPLICATION_QUEUE:{send:vi.fn()}} as unknown as Env;
  await db.prepare('INSERT INTO users(name,email,mode,master_profile) VALUES(?,?,?,?)').bind(profile.name,profile.email,profile.mode,JSON.stringify(profile)).run();
  await addJobs(env,1,[{title:'Python Intern',company:'Review Co',url:'https://example.com/jobs/review',description:'Python tooling internship.',listing_type:'internship'}]);await getPlan(env,1);
},30000);
afterEach(async()=>{vi.unstubAllGlobals();await mf?.dispose();},30000);
async function app(){return (await db.prepare(`${applicationQuery} WHERE a.id=1`).first<any>())!;}
async function approve(answers:Record<string,string>={'Why do you want to work here?':'My Python coursework is relevant.'}){
  const row=await app(),user=await userById(env,1);
  return createSubmissionReview(env,1,1,{resume_version:row.resume_version,profile_version:user.profile_version,answers,reviewed:true});
}
async function confirm(){const review=await approve();await confirmPlan(env,1,[(await app()).job_id],[review.review_id]);return review;}

describe('reviewed immutable versions and final authorization',()=>{
  it('requires explicit review before confirmation and queues the exact authorization generation',async()=>{
    await expect(confirmPlan(env,1,[(await app()).job_id])).rejects.toMatchObject({status:409});
    const review=await confirm(),row=await app();
    expect(row).toMatchObject({status:'confirmed',confirmed_review_id:review.review_id});
    expect(env.APPLICATION_QUEUE.send).toHaveBeenCalledWith({application_id:1,kind:'apply',review_id:review.review_id});
    expect(await getValidSubmissionReview(env,row,await userById(env,1))).toMatchObject({reviewId:review.review_id,answers:{'why do you want to work here':'My Python coursework is relevant.'}});
    expect(await validateSubmissionReview(env,review.review_id,review.binding)).toBe(true);
  });
  it('saves immutable edited PDFs and never changes the master profile or old bytes',async()=>{
    const original=await app(),old=await (await bucket.get(original.resume_path))!.arrayBuffer(),draft=await resumeDraft(env,1,1),review=await approve();
    const changed=await editResume(env,1,1,{base_version:1,profile_version:1,draft:{...draft.draft,summary:'Built and documented a Python task planner.'}});
    expect(changed).toMatchObject({resume_version:2,draft:{summary:'Built and documented a Python task planner.'}});
    expect(changed).toEqual(await resumeDraft(env,1,1));
    expect(changed.versions).toHaveLength(2);expect(changed.previous_draft?.summary).toBe(draft.draft.summary);
    expect(await (await bucket.get(original.resume_path))!.arrayBuffer()).toEqual(old);
    expect((await userById(env,1)).master_profile).toEqual(profile);
    expect((await db.prepare('SELECT revoked_at FROM submission_reviews WHERE id=?').bind(review.review_id).first<any>())!.revoked_at).toBeTruthy();
    await expect(confirmPlan(env,1,[original.job_id],[review.review_id])).rejects.toMatchObject({status:409});
  });
  it('permits only one concurrent edit of the same base version and cleans the losing object',async()=>{
    const draft=await resumeDraft(env,1,1),input={base_version:1,profile_version:1,draft:{...draft.draft,summary:'Built a reviewed Python planning project.'}};
    const result=await Promise.allSettled([editResume(env,1,1,input),editResume(env,1,1,input)]);
    expect(result.filter(item=>item.status==='fulfilled')).toHaveLength(1);
    expect((await db.prepare('SELECT * FROM resumes').all()).results).toHaveLength(2);
    expect((await bucket.list()).objects).toHaveLength(2);
  });
  it.each(['profile','swap'] as const)('rejects a concurrent %s change after upload and removes only the losing PDF',async change=>{
    if(change==='swap'){
      await db.prepare('UPDATE users SET weekly_quota=1 WHERE id=1').run();
      await addJobs(env,1,[{title:'Python Tools Intern',company:'Other Review Co',url:'https://example.com/jobs/other-review',description:'Python tools internship.',listing_type:'internship'}]);
    }
    const original=await app(),draft=await resumeDraft(env,1,1),oldBytes=await (await bucket.get(original.resume_path))!.arrayBuffer();
    let uploadedKey:string|undefined;
    const editingEnv={...env,FILES:{
      async put(...args:Parameters<typeof bucket.put>){const uploaded=await bucket.put(...args);uploadedKey=args[0];if(change==='profile')await db.prepare('UPDATE users SET profile_version=profile_version+1 WHERE id=1').run();else await swapPlan(env,1,1,2);return uploaded;},
      get:(key:string)=>bucket.get(key),delete:(key:string)=>bucket.delete(key),
    }} as unknown as Env;
    await expect(editResume(editingEnv,1,1,{base_version:1,profile_version:1,draft:{...draft.draft,summary:'Built a reviewed Python planning project.'}})).rejects.toMatchObject({status:409});
    expect(uploadedKey).toBeTruthy();expect(await bucket.get(uploadedKey!)).toBeNull();
    expect(await (await bucket.get(original.resume_path))!.arrayBuffer()).toEqual(oldBytes);
    expect((await db.prepare('SELECT version FROM resumes WHERE application_id=1 ORDER BY version').all()).results).toEqual([{version:1}]);
    expect((await app()).resume_version).toBe(1);
    expect(change==='profile'?(await app()).resume_path:(await app()).status).toBe(change==='profile'?null:'pending');
  });
  it('blocks rejected PDFs, retains history and permits a new explicitly edited version',async()=>{
    await rejectResume(env,1,1,{resume_version:1});expect((await resumeDraft(env,1,1)).rejected).toBe(true);
    await expect(approve()).rejects.toMatchObject({status:409});
    const draft=await resumeDraft(env,1,1);await editResume(env,1,1,{base_version:1,profile_version:1,draft:{...draft.draft,summary:'Built a truthful Python project.'}});
    expect((await resumeDraft(env,1,1)).rejected).toBe(false);await confirm();
  });
  it('invalidates queued approval on profile changes, clears drafts and preserves submitted versions',async()=>{
    const review=await confirm(),before=await app();
    await db.prepare('UPDATE users SET profile_version=2 WHERE id=1').run();
    expect(await app()).toMatchObject({status:'planned',confirmed_review_id:null,resume_path:null});
    expect(await validateSubmissionReview(env,review.review_id,review.binding)).toBe(false);
    expect((await db.prepare("SELECT * FROM outbox WHERE kind='apply'").all()).results).toHaveLength(0);
    expect(await bucket.get(before.resume_path)).not.toBeNull();
  });
  it('invalidates material listing changes instead of submitting a different JD',async()=>{
    const review=await confirm();await db.prepare("UPDATE jobs SET description='A different role with different requirements' WHERE id=1").run();
    expect(await app()).toMatchObject({status:'planned',resume_path:null,confirmed_review_id:null});
    expect(await validateSubmissionReview(env,review.review_id,review.binding)).toBe(false);
  });
  it('refuses changed answers, changed PDF bytes and expired reviews',async()=>{
    const review=await confirm(),row=await app(),user=await userById(env,1);
    expect(await getValidSubmissionReview(env,row,user,new TextEncoder().encode('changed bytes'))).toBeNull();
    await db.prepare('UPDATE submission_reviews SET answers=? WHERE id=?').bind(JSON.stringify({question:'A tampered answer'}),review.review_id).run();
    expect(await getValidSubmissionReview(env,row,user)).toBeNull();
    await db.prepare("UPDATE submission_reviews SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").bind(review.review_id).run();
    expect(await validateSubmissionReview(env,review.review_id,review.binding)).toBe(false);
  });
  it('revokes the previous answer approval atomically when a replacement is saved',async()=>{
    const a=await approve(),b=await approve({'Why do you want to work here?':'My reviewed replacement answer.'});
    const rows=(await db.prepare('SELECT id,revoked_at FROM submission_reviews ORDER BY created_at,id').all<any>()).results;
    expect(rows.find(row=>row.id===a.review_id)?.revoked_at).toBeTruthy();expect(rows.find(row=>row.id===b.review_id)?.revoked_at).toBeNull();
    await expect(confirmPlan(env,1,[1],[a.review_id])).rejects.toMatchObject({status:409});await confirmPlan(env,1,[1],[b.review_id]);
    expect(await validateSubmissionReview(env,a.review_id,a.binding)).toBe(false);
    expect(await validateSubmissionReview(env,b.review_id,b.binding)).toBe(true);
  });
  it('cancels queued work, revokes authorization and rejects cancellation after execution starts',async()=>{
    const review=await confirm();const result=await cancelQueuedApplication(env,1,1);
    expect(result).toMatchObject({cancelled:true,status:'planned'});expect(await app()).toMatchObject({status:'planned',confirmed_review_id:null});
    expect(await validateSubmissionReview(env,review.review_id,review.binding)).toBe(false);
    expect((await db.prepare("SELECT * FROM outbox WHERE kind='apply'").all()).results).toHaveLength(0);
    await confirm();await db.prepare("UPDATE applications SET status='applying' WHERE id=1").run();
    await expect(cancelQueuedApplication(env,1,1)).rejects.toMatchObject({status:409});
    expect((await app()).status).toBe('applying');
  });
  it('has a single winner between cancellation and an atomic worker claim',async()=>{
    await confirm();const result=await Promise.allSettled([cancelQueuedApplication(env,1,1),db.prepare("UPDATE applications SET status='applying' WHERE id=1 AND status='confirmed' RETURNING id").all<any>()]);
    const status=(await app()).status;
    if(status==='planned'){expect(result[0].status).toBe('fulfilled');expect((result[1] as PromiseFulfilledResult<any>).value.results).toHaveLength(0);}
    else{expect(status).toBe('applying');expect(result[0].status).toBe('rejected');expect((result[1] as PromiseFulfilledResult<any>).value.results).toHaveLength(1);}
  });
  it('never marks a replacement approval dispatched when a cancelled outbox ID is reused',async()=>{
    const old=await confirm();await db.prepare("UPDATE outbox SET dispatched_at=NULL WHERE kind='apply'").run();
    let entered!:()=>void,release!:()=>void;const sending=new Promise<void>(resolve=>entered=resolve),hold=new Promise<void>(resolve=>release=resolve);
    env.APPLICATION_QUEUE.send=vi.fn(async()=>{entered();await hold;return{metadata:{metrics:{backlogCount:0,backlogBytes:0}}};});
    const pending=dispatchOutbox(env);await sending;await cancelQueuedApplication(env,1,1);
    const current=await approve();await db.prepare("INSERT INTO outbox(application_id,kind,review_id) VALUES(1,'apply',?)").bind(current.review_id).run();
    release();await pending;
    const outbox=await db.prepare("SELECT review_id,dispatched_at FROM outbox WHERE application_id=1 AND kind='apply'").first<any>();
    expect(outbox).toEqual({review_id:current.review_id,dispatched_at:null});expect(current.review_id).not.toBe(old.review_id);
  });
  it('bounds manual provider regeneration requests and requires review of the new PDF',async()=>{
    const review=await approve();for(let i=0;i<3;i++)await regenerateResume(env,1,1,{resume_version:1});
    await expect(regenerateResume(env,1,1,{resume_version:1})).rejects.toMatchObject({status:429});
    const plan=await getPlan(env,1);expect(plan.plan[0]).toMatchObject({resume_version:2,review_id:null});
    await expect(confirmPlan(env,1,[1],[review.review_id])).rejects.toMatchObject({status:409});
  });
  it('checks ownership and rejects oversized or invalid answer catalogs',async()=>{
    await db.prepare("INSERT INTO users(name,email,mode) VALUES('Other Candidate','other-review@example.com','internship')").run();
    await expect(resumeDraft(env,2,1)).rejects.toMatchObject({status:404});await expect(cancelQueuedApplication(env,2,1)).rejects.toMatchObject({status:404});
    await expect(editResume(env,2,1,{base_version:1,profile_version:1,draft:{summary:'A cross-owner edit'}})).rejects.toMatchObject({status:404});
    expect((await bucket.list()).objects).toHaveLength(1);
    await expect(createSubmissionReview(env,1,1,{resume_version:1,profile_version:1,reviewed:true,answers:{question:'x'.repeat(3001)}})).rejects.toMatchObject({status:422});
    await expect(createSubmissionReview(env,1,1,{resume_version:1,profile_version:1,reviewed:false,answers:{}})).rejects.toMatchObject({status:422});
  });
  it('inspects public form questions read-only and never invents eligibility answers',async()=>{
    const fetcher=vi.fn(async(_input:RequestInfo|URL,_init?:RequestInit)=>new Response('<form><label for="visa">Do you need visa sponsorship?</label><textarea id="visa"></textarea><textarea aria-label="Why this role?"></textarea></form>',{headers:{'Content-Type':'text/html'}}));vi.stubGlobal('fetch',fetcher);
    const review=await reviewQuestions(env,1,1);
    expect(review.questions.find(item=>/visa/.test(item.question))?.answer).toBe('');
    expect(review.questions.find(item=>item.question==='Why this role?')?.answer).toContain('Python');
    expect(fetcher).toHaveBeenCalledWith('https://example.com/jobs/review',expect.objectContaining({redirect:'manual'}));
    expect((fetcher.mock.calls[0][1] as RequestInit).method).toBeUndefined();
  });
});
