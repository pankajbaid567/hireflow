import type {Env,Row} from './types';
import {all} from './storage';
import {companyAliases,companyKey} from './listing_details';

/** No automatic reapplication window. Only durable submission evidence blocks
 * an employer, not a generic timeout/CAPTCHA or a similarly named company. */
export async function submittedCompanies(env:Env,userId:number,profile:Row={}):Promise<Set<string>>{
  const rows=await all(env,`SELECT DISTINCT j.id,j.company AS current_company,j.company_key,COALESCE(json_extract(a.job_snapshot,'$.company'),j.company) AS company FROM applications a JOIN jobs j ON j.id=a.job_id
    LEFT JOIN automation_checkpoints c ON c.application_id=a.id
    WHERE a.user_id=? AND (a.applied_at IS NOT NULL OR a.status IN ('applied','interview','offer')
      OR (a.status='needs_action' AND c.phase IN ('advancing','submitting','submitted','uncertain')))`,userId);
  const stale=rows.filter(row=>row.company_key!==companyKey(row.current_company));
  if(stale.length)await env.DB.batch(stale.map(row=>env.DB.prepare('UPDATE jobs SET company_key=? WHERE id=?').bind(companyKey(row.current_company),row.id)));
  return new Set(rows.flatMap(row=>companyAliases(row.company,profile)).filter(Boolean));
}
export function companyWasSubmitted(job:Row,companies:Set<string>):boolean{return companies.has(companyKey(job.company));}
