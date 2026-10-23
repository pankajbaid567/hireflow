# Both-mode production acceptance

This document describes the explicit P1-05/P1-06 production check. **Candidate
execution is pending** until a real deployment and proof are recorded below.
A local fixture or a collection of passing unit tests does not establish the
full production workflow.

## Reproduce

Use Node 22+, installed full Playwright Chromium, the project Python virtualenv,
Poppler (`pdftotext`), FFmpeg/ffprobe and authenticated local Wrangler access
for scoped read-only D1 inventory. The current deployed Worker must include
migrations 0008–0010, the Workers AI binding and the matching/review changes.
Run only on an authorized release:

```bash
HIREFLOW_WORKER_VERSION=ACTUAL_DEPLOYED_VERSION \
  node scripts/verify_p1_acceptance_live.mjs --run-live --record-demo
```

The script is restricted to `https://hireflow-dashboard.pages.dev`. The live flag
is required before it creates a workspace, calls providers or authorizes a QA
application. It creates **one synthetic PDF-only owner**, runs both modes and
makes exactly two application confirmations, each bound to an explicitly
reviewed HireFlow-owned QA form. No employer application or email is sent.
Real-source discovery consumes the configured search/AI allowance.

## Workflow and safety boundaries

| Stage | Required evidence |
| --- | --- |
| PDF-only intake | Actual configured Gemini extraction retains the fake name/email, zero professional years, education and the distinctive Atlas Note Assistant project. The actual model and fallback flag are recorded. |
| Internship discovery | Five separate source searches: Internshala, Wellfound, Greenhouse, Lever and LinkedIn. Source rows show actual verified/empty/restricted/unavailable outcomes. At least one active full JD must be persisted. |
| Job discovery | Four separate source searches: Naukri, LinkedIn, Greenhouse and Lever, with the same honest per-source evidence. A restricted Naukri result is not relabelled a Naukri success. |
| Matching and review | Normal plan output must actually report the BGE CLS embedding model and hybrid matching. The controlled opportunity is explicitly swapped into the plan; its private PDF and answers are reviewed. The internship PDF is edited to an immutable new version and compared before approval. |
| Submission | A browser request guard rejects confirmation unless its single job ID belongs to the exact owned-QA URL allowlist. Each controlled form must reach `applied` in one attempt with a full status trail. Real discovered listings remain unsubmitted. |
| Preparation | Each controlled application opens its saved guide, predicted rounds, expandable questions and real external resource links. This does not certify every resource or company-intel claim. |
| Mixed week | The same owner explicitly changes from quota one/Internship to quota two/Job. The first application continues to consume a slot. The final report contains both mode groups and two applied applications; switching mode back does not restore another slot. The submitted internship PDF stays byte-identical. |
| Privacy and mobile | The tracker/library/report render without 390px overflow. Logout returns private profile and PDF requests to 401. All identities and artifacts are synthetic. |

The owned form is a DOM-only simulation: the browser fills/uploads in memory,
clicks Submit and observes its confirmation, but no form data is transmitted to
an employer. This is production Worker/Queue/Browser Run evidence for the tested
workflow, **not ATS vendor certification**, login automation, or proof of a 100+
listing pool.

Provider failures, stale approval/profile changes, CAPTCHA/manual action,
interrupted browser state and budget exhaustion have separate controlled
runtime coverage in [task tests](../cloudflare/tests/tasks.test.ts),
[automation tests](../cloudflare/tests/automation.test.ts),
[review tests](../cloudflare/tests/review-workflow.test.ts),
[operations tests](../cloudflare/tests/operations.test.ts) and
[P1 workflow tests](../cloudflare/tests/p1-workflow.test.ts).
Those tests must be reported as controlled failure scenarios; they must not be
presented as additional real employer submissions.

## Recording and private proof

Proof and screenshots are written under
`/tmp/hireflow-p1-acceptance-live/<run-id>/` with private directory permissions.
The proof contains stage results, source diagnostics, fake owner/application/job
IDs and artifact keys, never session cookies, provider keys or recovery keys.
Only the sanitized main-page WebM is suitable for publication after visual
review; raw recordings and proof directories remain private.

The optional screencast shows the real UI, including native PDF preview and the
actual private HTML report. If its recorded duration falls outside the demo
window, its complete ordered event stream is uniformly time-scaled to a 3–5
minute WebM. The proof records original duration and scale. Captions identify
synthetic QA throughout. **Edited pacing is not a latency benchmark.**

Cleanup must match the exact fake owner ID and email from this run, revoke its
session, remove its own private uploads/resume/report versions and cascade its
application/review/vector rows. Delete only unreferenced **owned QA** job rows;
retain the actual verified public jobs discovered during the run. Do not reset
signup throttles, semantic usage or actual browser reservations. The capacity
sampler's separate owner must not be deleted before its before/after check ends.

## Results

Production run, deployment IDs, artifact link and scoped cleanup proof will be
added only after actual execution. The recording preflight verified local
Chromium WebM generation and ffprobe decoding with zero network requests; it
is not a production acceptance result.
