# HireFlow demo — four-minute walkthrough

Use the [live Pages dashboard](https://hireflow-dashboard.pages.dev/profile) with
an entirely synthetic profile/resume. The demonstration is a product walkthrough,
not evidence that every employer portal can be automated. Record no real contact
information, recovery keys, cookies, operator secrets or private user data.

## Recording and evidence status

[Watch the 4:45 production demo](https://hireflow-dashboard.pages.dev/assets/hireflow-p1-demo.webm).
Recorded **25 October 2026** from the real Pages UI and Worker
`d3848a38-6007-41bf-8112-7a228a3a101d` (`595f68e`). The captioned, silent VP9
screencast follows a synthetic PDF through both real source searches, genuine
BGE matching, exact PDF/answer review, two owned QA applications, preparation,
a mixed-week report, mobile and logout. [Sanitized proof](evidence/p1-production.json).

The complete ordered recording is uniformly time-scaled from **354.32 to 285
seconds**; no events were reordered or cut out. Loading/fallback states remain
visible. This edited pacing is **not a latency benchmark**. The browser's real
viewport is restored after PDF/report popups to avoid capture clipping; the
mobile portion is letterboxed. No image masks or invented UI states are used.
All contacts and projects are synthetic. No recovery keys/provider credentials,
employer submission or email delivery appears in the recording. Synthetic
workspaces/private files are cleaned after evidence is retained.

The timed four-minute table below remains a suggested narration guide; the
actual linked capture is a 4:45 captioned walkthrough.

## Timed sequence

| Time | On-screen action | Narration and permitted claim |
| --- | --- | --- |
| 0:00–0:35 | Show the profile screen, upload a synthetic PDF and review extracted fields. | “HireFlow turns a resume into editable facts. The browser owns a private workspace without entering an operator code. Extraction can fail safely; nothing is invented to fill a blank.” |
| 0:35–1:05 | Edit one project highlight; set Internship/Job mode, location and compensation preference. | “Preferences are explicit. The project facts remain the source for every tailored version. Pay and experience are interpreted only when evidence supports them.” |
| 1:05–1:40 | Find opportunities; show source rows, real original listing URLs, ranking and gaps. | “Discovery makes separate bounded searches per source and verifies full JDs. Restricted/empty sources stay visible. Ranking uses six factors plus a measured, limited semantic contribution; a score is not a hiring probability.” |
| 1:40–2:35 | Open **Review resume & answers**, edit a truthful clause, compare versions and approve. | “Each opportunity has its own immutable PDF. Editing/rejecting or changing source facts invalidates the previous approval. The queued task receives exactly the PDF and answers I reviewed.” |
| 2:35–3:10 | Demonstrate a controlled owned QA opportunity, tracker status and manual-action behavior. | “For this recording I use HireFlow’s QA form, not an employer vacancy. Supported forms can submit; CAPTCHA, login and uncertainty require manual action. A queued cancellation cannot withdraw an already submitted application.” |
| 3:10–3:40 | Open the prep guide, one expandable question, resource/source evidence and weekly report. | “Questions and study priorities are JD-specific. Predicted rounds are estimates, and missing company evidence stays unknown. Reports link the actual private PDF and guide; viewing one does not email anyone.” |
| 3:40–4:00 | Show service status/model diagnostics and the mobile layout, then sign out. | “Provider health and shared budgets are visible. A fallback is labelled and still requires review. Sign-out revokes private access.” |

Use a separate review-only synthetic workspace for discovery if necessary.
**Never click Confirm on a real discovered vacancy while recording QA.** For the
controlled apply segment, the only allowed URL is the owned
`https://hireflow-dashboard.pages.dev/assets/hireflow-qa-form` fixture. No real
employer POST or email belongs in this walkthrough.

## Preparation checklist

1. Verify the release IDs and relevant CI before recording. Start with a fresh
   browser context and choose a synthetic name, `example.com` email and invented
   projects. Avoid passkey/recovery-key screens in a public recording.
2. Prepare a one-page synthetic PDF containing explicit source facts. Wait for
   extraction/model output and review its truth rather than rushing to confirm.
3. Keep search/source diagnostics visible. Do not replace restricted/empty real
   sources with fabricated results. For the apply section, switch to the clearly
   labelled owned QA opportunity and retain its exact review gate.
4. Keep provider/browser limits intact. If capacity or a provider is unavailable,
   show the safe state or record a truthful separate segment; do not reset usage,
   weaken authorization or present fallback as a model success.
5. Capture 3–5 minutes of readable desktop footage, show a short mobile view, and
   inspect the video before publishing. Record duration, timestamp, synthetic
   scope and release IDs with the artifact. Cleanup only the synthetic workspace
   and its files after retaining sanitized evidence.

## Useful engineering explanation after the demo

The [architecture](architecture.md) explains Pages → Worker → D1/private files →
outbox/queue → browser execution, separate from Python/PostgreSQL/FAISS. The
[evaluation](ai-evaluation.md) includes real model provenance, baseline/hybrid
metrics, the extraction error that was found and corrected, source-preserving
selection checks and limits of the synthetic labels. Use those as substantiation;
functional test counts alone do not establish AI quality.
