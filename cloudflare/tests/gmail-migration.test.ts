/** Real D1 migration with populated relationships; no external requests. */
import {afterEach,beforeEach,expect,it} from 'vitest';
import {readFileSync,readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
const directory=fileURLToPath(new URL('../migrations/',import.meta.url));
let mf:Miniflare,db:Awaited<ReturnType<Miniflare['getD1Database']>>;
async function migration(file:string){const sql=unstable_splitSqlQuery(readFileSync(directory+file,'utf8'));await db.batch(sql.map(value=>db.prepare(value)));}
beforeEach(async()=>{
 mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response(null,{status:404});}}',compatibilityDate:'2026-10-21',compatibilityFlags:['nodejs_compat'],d1Databases:['DB'],outboundService(){throw new Error('External network forbidden');}}));db=await mf.getD1Database('DB');
 for(const name of readdirSync(directory).filter(name=>/^\d+.*\.sql$/.test(name)&&Number(name.slice(0,4))<=19).sort())await migration(name);
 await db.prepare("INSERT INTO users(id,name,email,mode) VALUES(1,'Migration QA','migration@example.com','internship')").run();
 await db.prepare("INSERT INTO weekly_reports(id,user_id,week_start_date,content,metrics,applied_count,avg_match_score,html_path) VALUES(1,1,'2026-10-26','{}','{}',0,0,'report-v1.html')").run();
 for(const [index,provider]of ['resend','sendgrid'].entries()){
  const run='run-'+index,id='delivery-'+index;
  await db.prepare("INSERT INTO weekly_schedule_runs(id,user_id,local_week,schedule_version,profile_version,settings,state,created_at,expires_at) VALUES(?,1,?,1,1,'{}','waiting','2026-10-26T00:00:00Z','2099-01-01')").bind(run,'2026-10-'+(19+index*7)).run();
  await db.prepare("INSERT INTO workspace_reminders(id,user_id,run_id,message,created_at) VALUES(?,1,?,'Migration fixture','2026-10-26T00:00:00Z')").bind('reminder-'+index,run).run();
  await db.prepare(`INSERT INTO email_deliveries(id,user_id,report_id,report_key,provider,recipient,sender,subject,payload_key,payload_hash,source_artifacts,source_snapshot,state,idempotency_key,attempts,schedule_run_id,schedule_version,attachment_count,provider_message_id,provider_status,lease_token,first_attempt_at,accepted_at,created_at,expires_at,delivery_status,delivery_status_at,receipt_received_at,receipt_provider_message_id) VALUES(?,1,1,'report-v1.html',?,'migration@example.com','weekly@hireflow.test','Migration report',?,'immutable-payload-hash','["resume-v2.pdf"]','{"immutable":true}','accepted',?,1,?,1,1,?,202,NULL,'2026-10-26T00:00:01Z','2026-10-26T00:00:02Z','2026-10-26T00:00:00Z','2099-01-01','delivered','2026-10-26T00:00:03Z','2026-10-26T00:00:04Z',?)`).bind(id,provider,'payload-'+index+'.json','idempotency-'+index,run,'api-message-'+index,'receipt-message-'+index).run();
  await db.prepare('UPDATE weekly_schedule_runs SET email_delivery_id=? WHERE id=?').bind(id,run).run();
  await db.prepare("INSERT INTO email_receipt_events(provider,event_id_hash,delivery_id,event_type,outcome,occurred_at,received_at,content_hash,ingestion_id) VALUES(?,?,?,'delivered','delivered','2026-10-26T00:00:03Z','2026-10-26T00:00:04Z','immutable-receipt-hash','fixture-ingestion')").bind(provider,'event-hash-'+index,id).run();
 }
},30000);
afterEach(async()=>{await mf?.dispose();},30000);
it('preserves every populated provider/receipt/schedule fact and all protection after adding Gmail',async()=>{
 const rows=async(table:string)=>(await db.prepare('SELECT * FROM '+table+' ORDER BY 1').all()).results;
 const tables=['email_deliveries','email_receipt_events','weekly_schedule_runs','workspace_reminders','workspace_revisions'],before=await Promise.all(tables.map(rows));
 await migration('0020_gmail_delivery.sql');for(const [index,table]of tables.entries())expect(await rows(table),table).toEqual(before[index]);
 expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
 const triggers=(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name='email_deliveries' OR tbl_name='email_receipt_events')").all()).results;expect(triggers).toHaveLength(8);
 await expect(db.prepare("UPDATE email_deliveries SET provider='gmail' WHERE id='delivery-0'").run()).rejects.toThrow(/immutable/);
 await expect(db.prepare("UPDATE email_receipt_events SET outcome='failed'").run()).rejects.toThrow(/immutable/);
 await db.prepare("INSERT INTO workspace_artifact_tombstones(object_key,claimed_at) VALUES('payload-0.json','2026-10-26')").run();await expect(db.prepare("UPDATE email_deliveries SET state='failed' WHERE id='delivery-0'").run()).rejects.toThrow(/retired/);await db.prepare('DELETE FROM workspace_artifact_tombstones').run();
 const revision=Number((await rows('workspace_revisions'))[0].revision);await db.prepare("UPDATE email_deliveries SET failure_reason='new visible outcome' WHERE id='delivery-0'").run();expect(Number((await rows('workspace_revisions'))[0].revision)).toBeGreaterThan(revision);
 await db.prepare("DELETE FROM email_deliveries WHERE id='delivery-0'").run();expect((await rows('email_receipt_events'))).toHaveLength(1);expect((await rows('weekly_schedule_runs'))[0].email_delivery_id).toBeNull();expect(await rows('workspace_reminders')).toHaveLength(2);
 await db.prepare('DELETE FROM users WHERE id=1').run();for(const table of tables)expect(await rows(table)).toEqual([]);
});
it('admits a real Gmail provider label while preserving checks, immutable bindings and global allowance',async()=>{
 await migration('0020_gmail_delivery.sql');const source=(await db.prepare("SELECT * FROM email_deliveries WHERE id='delivery-0'").first<Record<string,any>>())!,row={...source,id:'gmail-delivery',provider:'gmail',payload_key:'gmail-payload.json',idempotency_key:'gmail-key',schedule_run_id:null};const columns=Object.keys(row);
 await db.prepare(`INSERT INTO email_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(key=>row[key as keyof typeof row])).run();expect((await db.prepare("SELECT provider FROM email_deliveries WHERE id='gmail-delivery'").first<any>())!.provider).toBe('gmail');
 const invalid={...row,id:'invalid-provider',provider:'arbitrary',payload_key:'invalid.json',idempotency_key:'invalid'};await expect(db.prepare(`INSERT INTO email_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).bind(...columns.map(key=>invalid[key as keyof typeof invalid])).run()).rejects.toThrow(/CHECK/);
 await db.prepare("INSERT INTO gmail_daily_usage(day,attempts) VALUES('2026-10-26',1)").run();await expect(db.prepare("UPDATE gmail_daily_usage SET attempts=-1").run()).rejects.toThrow(/CHECK/);
 expect((await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%saved'").all()).results).toEqual([]);
});
