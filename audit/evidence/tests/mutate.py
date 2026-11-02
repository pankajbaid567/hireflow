"""Phase 5 mutation sampling. For each hand-written guard-breaking mutation: apply to the source,
run the *targeted* vitest files, record KILLED (some test failed) / SURVIVED / INVALID (typecheck-level error
before any assertion, i.e. mutation itself broke loading), then restore via original bytes.
usage: python3 mutate.py <repo> [id ...]   (env: PATH must contain Node>=22.12)"""
import json, os, subprocess, sys, time, pathlib
repo = pathlib.Path(sys.argv[1]).resolve(); cf = repo / 'cloudflare'
ONLY = set(sys.argv[2:])
ORDER = ['tasks.test.ts', 'automation.test.ts', 'automation-runtime.test.ts', 'review-workflow.test.ts']
M = [
 ('M01','duplicate-submission','tasks.ts','WHERE id=? AND status=\'confirmed\' AND confirmed_review_id=?','WHERE id=? AND confirmed_review_id=?',['tasks.test.ts','automation-runtime.test.ts','p1-workflow.test.ts']),
 ('M02','approval-binding','tasks.ts','AND revoked_at IS NULL AND approved_at IS NOT NULL','AND approved_at IS NOT NULL',['tasks.test.ts','review-workflow.test.ts','automation-runtime.test.ts']),
 ('M03','approval-binding','tasks.ts','AND approved_at IS NOT NULL AND expires_at>?)','AND approved_at IS NOT NULL AND (expires_at>? OR 1=1))',['tasks.test.ts','review-workflow.test.ts','automation-runtime.test.ts']),
 ('M04','approval-binding','tasks.ts','AND EXISTS(SELECT 1 FROM users WHERE id=applications.user_id AND profile_version=?)','AND (EXISTS(SELECT 1 FROM users WHERE id=applications.user_id AND profile_version=?) OR 1=1)',['tasks.test.ts','review-workflow.test.ts','automation-runtime.test.ts','p1-jd-races.test.ts']),
 ('M05','pre-submit-recheck','automation.ts',"if (!input.reviewBinding || !input.beforeFinalSubmit || !await input.beforeFinalSubmit()) throw new AutomationError('The reviewed resume","if (false) throw new AutomationError('The reviewed resume",['automation.test.ts','automation-runtime.test.ts','tasks.test.ts']),
 ('M06','submitting-checkpoint','automation.ts',"if (checkpoint) await save({ ...checkpoint, phase: 'submitting' });","",['automation.test.ts','automation-runtime.test.ts','tasks.test.ts']),
 ('M07','checkpoint-forward-only','automation_checkpoints.ts',"WHERE automation_checkpoints.phase='ready' OR","WHERE 1=1 OR",['automation.test.ts','automation-runtime.test.ts','tasks.test.ts']),
 ('M08','session-expiry','auth.ts',"WHERE token_hash=? AND expires_at>?","WHERE token_hash=? AND (expires_at>? OR 1=1)",['api.test.ts','account-security.test.ts','session_transfer.test.ts']),
 ('M09','logout-revoke','auth.ts',"if (token) await run(env, 'DELETE FROM sessions WHERE token_hash=?', await digest(token));","",['api.test.ts','account-security.test.ts']),
 ('M10','tenant-isolation','index.ts'," WHERE a.user_id=?'"," WHERE (a.user_id=? OR 1=1)'",['api.test.ts','tasks.test.ts','review-workflow.test.ts']),
 ('M11','tenant-isolation','index.ts',"'SELECT * FROM applications WHERE id=? AND user_id=?'","'SELECT * FROM applications WHERE id=? AND (user_id=? OR 1=1)'",['api.test.ts','tasks.test.ts','review-workflow.test.ts']),
 ('M12','scoring-weights','intelligence.ts',".4*technical_score+.2*role",".5*technical_score+.2*role",['intelligence.test.ts','semantic-matching.test.ts','intelligence-runtime.test.ts']),
 ('M13','ssrf','public_url.ts',"a === 169 && b === 254","a === 169 && b === 999",['p1-workflow.test.ts','dynamic-source.test.ts','automation.test.ts','source-reader.test.ts','discovery.test.ts']),
 ('M14','email-attachment','gmail_transport.ts',"||content.subarray(0,5).toString('ascii')!=='%PDF-'","",['gmail-transport.test.ts','gmail-delivery.test.ts','email-delivery.test.ts']),
 ('M15','llm-id-whitelist','resume_tailoring.ts',"data.summary_fact_ids.some((id: unknown) => typeof id !== 'string' || !ids.has(id))","data.summary_fact_ids.some((id: unknown) => typeof id !== 'string')",['resume-tailoring.test.ts','intelligence.test.ts']),
 ('M16','prep-injection-guard','prep_intelligence.ts',"question.length<25||unsafeInstruction.test(question)||","question.length<25||",['prep-quality.test.ts','intelligence.test.ts','intelligence-runtime.test.ts']),
 ('M17','login-rate-limit','auth.ts',"WHERE window_start<? OR attempts<10 RETURNING attempts","WHERE window_start<? OR attempts<1000 RETURNING attempts",['api.test.ts','signup-limits.test.ts','account-security.test.ts']),
 ('M18','html-escape','reports.ts',"'<':'&lt;','>':'&gt;'","'<':'<','>':'>'",['reports.test.ts','api.test.ts','hiring-reports.test.ts']),
 ('M19','html-escape','prep_document.ts',"'<':'&lt;','>':'&gt;'","'<':'<','>':'>'",['prep-exports.test.ts','prep-quality.test.ts','intelligence.test.ts']),
 ('M20','session-transfer-single-use','session_transfer.ts',"DELETE FROM session_transfers WHERE token_hash=? AND claimed_session_id=?","DELETE FROM session_transfers WHERE token_hash=? AND claimed_session_id=? AND 1=0",['session_transfer.test.ts','api.test.ts']),
]
results = []
for mid, inv, fname, old, new, tests in M:
    if ONLY and mid not in ONLY: continue
    path = cf / 'src' / fname; orig = path.read_bytes(); text = orig.decode()
    if text.count(old) != 1:
        results.append(dict(id=mid, invariant=inv, file=fname, status='INVALID', note=f'anchor count={text.count(old)}')); continue
    tests = [] if os.environ.get('FULL') else [t for t in tests if (cf / 'tests' / t).exists()]
    try:
        path.write_text(text.replace(old, new))
        t0 = time.time()
        p = subprocess.run(['npx', 'vitest', 'run', *[f'tests/{t}' for t in tests], '--reporter=json', *([] if os.environ.get('FULL') else ['--bail=1'])], cwd=cf, capture_output=True, text=True, timeout=1500)
        dt = round(time.time() - t0)
        try:
            j = json.loads(p.stdout[p.stdout.index('{'):]); failed = j.get('numFailedTests', 0); total = j.get('numTotalTests', 0)
            names = [a['fullName'][:110] for s in j.get('testResults', []) for a in s.get('assertionResults', []) if a['status'] == 'failed'][:6]
            suite_err = any(s.get('status') == 'failed' and not s.get('assertionResults') for s in j.get('testResults', []))
        except Exception:
            failed, total, names, suite_err = -1, -1, [], True
        status = 'INVALID' if suite_err and failed <= 0 else 'KILLED' if failed > 0 else 'SURVIVED'
        results.append(dict(id=mid, invariant=inv, file=fname, status=status, tests=tests, failed=failed, total=total, killed_by=names, seconds=dt))
    finally:
        path.write_bytes(orig)
    print(results[-1], file=sys.stderr, flush=True)
print(json.dumps(results, indent=1))
