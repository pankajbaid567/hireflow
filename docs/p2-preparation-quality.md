# Preparation quality and company evidence

P2-03 uses `prep-evidence-v2` in the Worker and Python agents. The Worker keeps research and generation in queue consumers; reading a guide only reads its saved data and refresh status.

## Questions and study topics

The fallback uses actual responsibility spans from the JD, relevant projects the user actually supplied, and concrete task constraints. Booking conflicts, repeated stock updates, search relevance and uncertain observations lead to different decisions and test cases. Internship prompts use small prototypes and mentor feedback; Job prompts discuss production boundaries, observable tradeoffs and recovery.

A supported, substantive JD normally produces 5–10 questions across technical, behavioral and design categories. A sparse JD can produce fewer, with a visible shortfall warning. Extra questions and candidate achievements are not invented to meet a count. Optional LLM output must contain 5–10 distinct, grounded questions in all three categories; generic/company-label padding, repeated prompts, unsupported candidate-experience assertions and inappropriate internship depth are rejected in favor of local guidance. These checks are conservative text checks, not a guarantee of model factuality.

`topics` retains the original strong/moderate/gaps arrays. `topic_evidence` explains their basis:

- **Strong:** explicitly listed by the candidate; proficiency remains self-reported.
- **Moderate:** actual project/experience mention or a documented related skill; this does not establish proficiency in the required skill.
- **Gap:** no supporting profile evidence, or an explicitly supplied gap.

Only custom/structured skills actually mentioned in the JD are included. Java and JavaScript remain separate; a project saying a skill has not been used does not establish familiarity.

## Company sources and uncertainty

Accessible public company and explicitly linked career pages are inspected with bounded reads and safe redirect checks. Attributed source bodies take precedence over search snippets. If an injectable source provides only accessibility plus a search excerpt, that weaker basis is explicitly labeled `accessible_search_excerpt`, rather than described as an inspected-page fact. Missing facts remain unknown. Supplied company-stage context remains a labeled estimate until a source supports it.

Stage, approximate team size and technology claims carry `claim_evidence` entries with value, source URL, quote, evidence kind and check time. Technology requirements in the JD are distinct from claims about the whole company's stack. Competitor sentences, customer-stage descriptions and negated claims do not establish company facts.

Interview rounds use explicit JD process text first, then accessible company career evidence. Unreported stages are marked as estimates. Candidate reviews never establish confirmed current rounds. News requires an absolute date within the last 90 days; an inspected source date overrides search metadata, including rejecting contradictory old/future dates. Historical candidate reports are labeled historical, and undated reports retain an unknown date. Neither is presented as the current interview process.

The dashboard displays round estimates, JD quotes, topic explanations, source citations, approximate company facts and review-date limitations. Source links retain safe external-link handling.

## Learning resources and budgets

Research prioritizes company evidence and then at most three study topics, with gaps first. A topic returns 2–3 links when accessible, topical candidates are available. Broken links, unsafe redirects and irrelevant company/job pages are skipped; a second search can locate alternatives. Each emitted resource includes its topic, check time and accessibility/metadata validation basis. Fewer than two useful accessible links produces an explicit warning.

The existing Worker research cap remains **24 fetches**, plus at most one question-generation request, with a 45-second deadline for starting research reads (an in-flight shared read has its own 12-second cap). Public-page readers cap source bodies at 180,000 bytes and visible text at 30,000 characters. Accessibility and topical titles/descriptions do not amount to an independent review of teaching quality. Restricted sources and missing credentials produce partial results rather than invented citations or reviews.

Python uses the same prompt/topic/evidence policy and a bounded public-page reader. Production discovery and preparation additionally share the account/day and per-host source-budget adapter; cache hits do not spend another network/detail reservation. See [source adapter limits](p2-source-adapters.md). The runtime matrix documents remaining execution differences.

## Explicit refresh and immutable exports

Existing guides are retained until the owner requests **Refresh preparation**. `POST /applications/{id}/prep-guide/refresh` is owner-scoped and limited to three new refreshes per ten minutes. Repeated requests reuse the active ticket. It persists before dispatch, and maintenance can dispatch a ticket after a queue outage.

The consumer atomically claims its token and captures the current profile version and the relevant JD version. Submitted applications use their immutable listing snapshot. A profile edit, applicable JD change, expired lease or newer token prevents an older consumer from replacing the saved guide. Failed/expired refreshes keep the existing guide and a specific safe status. GET continues serving the saved guide while queued work runs; the dashboard polls status without repeating POST. Interrupted work stops at expiry and requires another explicit request.

A successful refresh changes the guide revision and marks older export snapshots stale. Previously generated private HTML/PDF bytes remain immutable. Refresh tickets are transient queue authority and are excluded from workspace backups/restores. Migration `0018_prep_refresh.sql` includes deletion cascades and workspace-revision triggers.

## Measured regression

Run:

```bash
node scripts/evaluate_prep_quality.mjs
node scripts/run_ai_evaluation.mjs --output evals/results/p2-offline.json
pytest tests/test_prep_guide.py tests/test_company_intel.py tests/test_prep_quality.py -q
```

The [P1 baseline](../evals/prep_v2/baseline-p1.json), [P2 thresholds](../evals/prep_v2/manifest.json) and [P2 report](../evals/results/preparation-p2.json) preserve the original corpus digest and labels. On the **same 16 known synthetic preparation cases**:

| Measurement | P1 | P2 |
| --- | ---: | ---: |
| Behavioral exact duplicate rate | 87.5% | 0% |
| All-question exact duplicate rate | 21.875% | 0% |
| Behavioral near-duplicate rate at token Jaccard ≥0.85 | Not measured | 0% |
| Minimum concrete JD goal-token coverage in question text | Not measured | 100% |
| Unsupported question JD-evidence spans | Not measured | 0 |

Company and actual project names are removed before P2 duplicate comparisons, so changing a name alone cannot create a distinct question. The question text itself supplies the relevance score; source metadata is checked separately. Question count/category, explicit round-count and internship/Job depth gates all pass. The full [120-case frozen evaluation](../evals/results/p2-offline.json) also passes without changes to ranking labels, six-factor weights, alpha or adoption thresholds. Controlled source responses now include an actual company-identity HTML body; the unchanged P1 fixture facts remain the expected claims.

These are known-case regression results: the cases were inspected during development. They are not a new blind heldout set, independent human ratings, real candidate outcomes or live website usefulness measurements. Runtime tests separately exercise source contradictions, competitor facts, unsafe redirects, broken resources, split Unicode, sparse/injected JDs and refresh races. No hosted provider probes, real employer submissions, emails or paid resources are represented by this offline evidence.
