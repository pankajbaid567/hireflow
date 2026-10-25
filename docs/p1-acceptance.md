# Both-mode production acceptance

This document describes the explicit P1-05/P1-06 production check. **The final
2026-10-25 release completed the full two-mode workflow**. The earlier failed
harness run remains recorded separately below.
A local fixture or a collection of passing unit tests does not establish the
full production workflow.

## Reproduce

Use Node 22+, installed full Playwright Chromium, the project Python virtualenv,
Poppler (`pdftotext`), FFmpeg/ffprobe and authenticated local Wrangler access
for scoped read-only D1 inventory. The current deployed Worker must include
migrations 0008–0012, the Workers AI binding, `PLAN_WORK_IN_QUEUE=true` and the
matching/review changes.
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
Current discovery returns a private `202` ticket; provider search, public-page
parsing and import run in the Queue. The check polls that owner's ticket until
`completed`, then verifies the final source rows rendered by the UI. `queued`
or `running` alone is not successful discovery. Failed/expired tickets stop the
run with their recorded reason, without another search or any confirmation.

## Workflow and safety boundaries

| Stage | Required evidence |
| --- | --- |
| PDF-only intake | Actual configured Gemini extraction retains the fake name/email, zero professional years, education and the distinctive Atlas Note Assistant project. The actual model and fallback flag are recorded. |
| Internship discovery | Five separate source searches: Internshala, Wellfound, Greenhouse, Lever and LinkedIn. Source rows show actual verified/empty/restricted/unavailable outcomes. At least one active full JD must be persisted. |
| Job discovery | Four separate source searches: Naukri, LinkedIn, Greenhouse and Lever, with the same honest per-source evidence. A restricted Naukri result is not relabelled a Naukri success. |
| Matching and review | Normal plan output must actually report the BGE CLS embedding model and hybrid matching. The controlled opportunity is explicitly swapped into the plan; its private PDF and answers are reviewed. The internship PDF is edited to an immutable new version and compared before approval. |
| Submission | A browser request guard rejects confirmation unless its single job ID belongs to the exact owned-QA URL allowlist. Each controlled form must reach `applied` within one to three attempts, with exactly one `applied` event and exactly one `applying` event per attempt. Every retry must have a reasoned `applying → confirmed → applying` trail. Actual attempt counts remain visible; real discovered listings remain unsubmitted. |
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
Private ticket ownership, duplicate delivery, profile/expiry races and recovery
also have [discovery Queue coverage](../cloudflare/tests/discovery-tasks.test.ts)
and [plan Queue coverage](../cloudflare/tests/plan-tasks.test.ts).
Those tests must be reported as controlled failure scenarios; they must not be
presented as additional real employer submissions.

## Recording and private proof

Proof and screenshots are written under
`/tmp/hireflow-p1-acceptance-live/<run-id>/` with private directory permissions.
The proof contains stage results, source diagnostics, fake owner/application/job
IDs and artifact keys, never session cookies, provider keys or recovery keys.
New runs also record stage timestamps and complete controlled-application
status timestamps/retry reasons, so edited video pacing cannot be mistaken for
actual cycle latency.
The owned-browser wait allows 330 seconds for the existing bounded attempts
and 40/80-second retry delays; the script still sends only one confirmation
per controlled opportunity.
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

### Final complete workflow — 2026-10-25

Run `83836557fce3` **passed** from **10:34:49.314 to 10:40:46.454 UTC** on
Worker `d3848a38-6007-41bf-8112-7a228a3a101d`, Pages `85755cd9` and source
`595f68e`, with migration 0012 and queued plan preparation enabled. One new
synthetic owner completed PDF-only signup, Internship and Job modes, exact
resume/answer review, two owned-form applications, saved preparation guides,
mixed-week report, quota back-switch, mobile views and logout.

The actual Gemini fallback was `gemini-3.5-flash-lite`; extracted identity,
education, the Atlas Note Assistant project and zero professional years were
retained. Manual QA additions genuinely waited for queued normalization,
hybrid BGE CLS matching and private PDF preparation. The internship PDF was
edited to immutable v2, compared and approved; Job used reviewed v1. Both
downloaded PDFs passed fact checks and visual rendering inspection.

Each source received its own actual Tavily search. The UI and owner-scoped D1
inventory verified eight public listings, with full descriptions of
2,453–5,388 characters and `json_ld` or `ats_api` provenance:

| Mode | Source | Verified | Observed status |
| --- | --- | ---: | --- |
| Internship | Internshala | 1 | ok |
| Internship | Wellfound | 2 | ok |
| Internship | Greenhouse | 0 | empty |
| Internship | Lever | 0 | empty |
| Internship | LinkedIn | 0 | restricted (4 results) |
| Job | Naukri | 0 | empty (4 searched) |
| Job | LinkedIn | 0 | restricted (4 results) |
| Job | Greenhouse | 3 | ok |
| Job | Lever | 2 | ok |

The Internship discovery ticket completed at **10:35:51.169 UTC** and Job at
**10:38:27.037 UTC**, through `202` start/`200` owner-only polling. Each owned
form reached `applied` in one attempt with the complete status trail. Exactly
two guarded confirmations were recorded; public listings remained unsubmitted.
Saved guides contained two rounds each, four/five questions respectively and
six resource links each. This checks saved guide rendering and link attributes,
not the correctness of every external resource or predicted company claim.

The report contained ten opportunities across both modes and two applied
applications, with shared UTC-week quota accounting. Switching back to
Internship did not restore another slot; the first submitted PDF stayed
byte-identical. Tracker/library/report loaded their actual data without 390px
horizontal overflow. Logout returned the private profile and both reviewed
PDF requests to `401`. Browser errors, HTTP 5xx, resource-limit responses,
out-of-scope browser requests, employer submissions and email sends were all
zero in this run. CPU/capacity conclusions are tracked separately from these
functional assertions.

The reviewed [captioned, silent demo](https://hireflow-dashboard.pages.dev/assets/hireflow-p1-demo.webm)
is **4:45**, 1366×768, VP9/20 fps and 5,742,147 bytes. The release retains
[sanitized production evidence](evidence/p1-production.json) separately from
private owner records.
The complete 354.32-second recording was uniformly time-scaled by 0.80436 with
no reordered or cut interactions. Actual native PDFs, private HTML report and
mobile view are visible. Full-page evidence snapshots briefly rescale some
frames; the phone view is letterboxed. No capture artifacts are masked.
**This edited pacing is not a latency benchmark.** Only the reviewed final
WebM is a publication asset. Raw recordings, cookies and private proof
directories remain private; the artifact contains no audio, credentials or
real applicant contact details.

### Historical first attempt — 2026-10-23

The authorized run `bd0e4e7807ac` started on **2026-10-23 at
09:21:05.372 UTC**, against Worker
`d9634e84-a645-4833-8da3-b091492f0e73` and Pages `cdc2de6a`, using one
synthetic PDF-only owner. Extraction used the configured Gemini fallback
`gemini-3.5-flash-lite`; zero professional years, education and the Atlas Note
Assistant project were preserved. The normal plan used
`@cf/baai/bge-small-en-v1.5:cls:profile-jd-v1` hybrid matching.

Actual discovery made one Tavily search per source (nine source searches in
total) and persisted five verified full descriptions in each mode:

| Mode | Source | Verified | Observed status |
| --- | --- | ---: | --- |
| Internship | Internshala | 1 | ok |
| Internship | Wellfound | 3 | ok |
| Internship | Greenhouse | 1 | ok |
| Internship | Lever | 0 | empty |
| Internship | LinkedIn | 0 | restricted (4 results) |
| Job | Naukri | 0 | empty (4 searched) |
| Job | LinkedIn | 0 | restricted (4 results) |
| Job | Greenhouse | 4 | ok |
| Job | Lever | 1 | ok (1 additional restricted result) |

Owner-scoped D1 verification recorded descriptions of 2,677–10,378 characters,
with `json_ld` or `ats_api` provenance. Unknown expiry remained unknown; the
one explicit expiry was later than the run date. No public listing was
confirmed or submitted.

The controlled internship reached `applied` in one browser attempt at
**09:23:18.852 UTC**, after an immutable PDF-v2 edit and exact PDF/answer
approval. Its saved preparation guide contained two rounds, four questions
and six resource links. The controlled Job application reached `applied` at
**09:26:42.167 UTC**, using two attempts: the first returned to `confirmed`
with the recorded reason “Temporary browser or network failure”, a 40-second
retry was scheduled, and the second succeeded. The durable checkpoint for
each application records `submitted`. This supports a bounded pre-submit
recovery; the original low-level exception was not retained, so its precise
cause cannot be established from the sanitized records.

The harness then failed its stricter `attempts === 1` assertion. **This is not
a complete acceptance pass.** The remaining Job-guide view, mixed-week report,
quota-back-switch, mobile/logout checks and final sanitized demo were not
completed in this run. The failed proof remains unchanged under the private
run directory, with a separate read-only diagnostic inventory. Exactly two
guarded confirmations and zero out-of-scope browser requests, employer
submissions or email sends were recorded. Its synthetic workspace was later
removed by scoped cleanup while private evidence was retained. No retry or replacement submission was
manually triggered during diagnosis.

The harness now accepts bounded recovery only with the full ordered status
invariants above. Offline validation accepted both recorded successful
histories and rejected six invalid histories, including missing retry reasons,
duplicate `applied` events, attempt-count mismatches and an uncertain outcome.
This corrects the harness requirement; it does not retroactively convert the
failed run into a complete pass. The final complete run above used a fresh
normal PDF-only signup, without an operator-created test login.

The earlier local recording preflight verified Chromium WebM generation and
ffprobe decoding with zero network requests; it is not production acceptance
evidence or a finished demonstration.

The reviewed demo was subsequently published by Pages deployment `c11dc0d8`.
Application JavaScript/CSS and the API Worker are identical to the tested UI
release; this publication adds the video artifact only.
