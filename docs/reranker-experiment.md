# Learned reranker experiment: retain the hybrid baseline

The learned model **did not improve the existing hybrid** on the reused synthetic
heldout set. Both scored **0.9511 nDCG@3**. The predeclared improvement gate failed,
so the model is **not adopted**. Production scoring, its six factors and semantic
alpha remain unchanged. P3-02 is an experiment and a measured decision, not a
claim that a new model should be deployed.

The [recorded run](../evals/reranker_v1/results/experiment.json) completed on
26 October 2026 at 20:12:25 UTC. It contains per-query rankings, domain/mode slices,
error counts, timings, source hashes and the decision. The small
[model artifact](../evals/reranker_v1/results/model.json) is offline research data;
no application module loads it.

## Frozen design and data

[Policy v1](../evals/reranker_v1/policy.json) was declared at 20:02:22 UTC, before
the first experiment fit. Its SHA-256 is
`15411534f0ac179b6e529311f6a9d884385e78033566e590d5627d9617915f45`.
The runner rejects a changed policy, corpus or vector artifact. No feature,
hyperparameter or adoption threshold was selected using the results below.

The original 120-case corpus is unchanged. Only its **48 ranking queries** are
used: 28 development queries over 14 primary domains, and 20 heldout queries over
10 other primary domains. Each query has five candidate listings. Grades remain
the repository's authored rubric: direct project/domain and stack match = 3,
adjacent domain and stack = 2, generic same-stack role = 1, unrelated domain or
missing required stack = 0. These are invented profiles/jobs and synthetic
preferences, not independent human judgments or hiring outcomes.

The heldout labels and baseline metrics were already published in P1. They are
excluded from fitting and tuning, but this is **reused heldout evaluation**, not
a newly blind benchmark. Selection, extraction, preparation and adversarial
cases never enter training. Existing local CPU BGE vectors retain their pinned
model revision, CLS pooling, dimensions and input hashes; no model is downloaded
or called during this experiment.

## Leakage controls

The domain split alone does not prevent repeated candidate descriptions. The
audit found two exact generic JD inputs shared across development and heldout,
covering 28 development rows. Another 28 rows share a normalized first description
sentence with a heldout JD, despite differing titles or surrounding text.

Training excludes both categories. It also fails on a shared query identity,
profile embedding input or primary domain. Candidate IDs are local tie breakers,
never learned features. All **100 heldout candidates remain unchanged**. Fitting
uses 84 development candidates in 28 queries, producing 70 unequal-grade pairs.
No heldout relevance grade determines an exclusion or an optimizer update.

This conservative embargo has a cost: the remaining training grades are
42 grade-0, zero grade-1, 28 grade-2 and 14 grade-3 rows. All generic grade-1
examples were repeated JDs and were removed. That incomplete coverage weakens
the experiment. Templates, general vocabulary and some domain concepts also
cross the corpus through distractors. Literal identity separation does not
establish semantic independence or real-world generalization.

## Model and predeclared gates

The model is a four-weight linear scorer with a query-normalized pairwise
logistic objective, inspired by the pairwise learning approach in
[Burges et al., 2005](https://www.microsoft.com/en-us/research/publication/learning-to-rank-using-gradient-descent/).
It is not a neural RankNet implementation or embedding fine-tuning.

Features come from the **actual Worker functions**, not a copied scoring engine:
the lexical six-factor score, explicit technical match fraction, frozen BGE
cosine, and technical fraction multiplied by cosine. The objective minimizes
`mean_query(mean_pairs(log(1 + exp(-w·(x_high - x_low))))) + 0.01·||w||²/2`.
It uses zero initial weights, 1,200 full-batch gradient steps and learning rate
0.2, without an intercept, feature scaling, search or early stopping. Scores
are uncalibrated ordering values, not eligibility or hiring probabilities.

The frozen adoption gates require:

- At least **+0.02 heldout nDCG@3** over the existing hybrid.
- No overall Recall@1 or Recall@3 regression.
- At most 0.01 mode-slice and 0.05 primary-domain nDCG@3 regression.
- Cached five-candidate rerank P95 below 5 ms and local fit below 5 seconds.
- Independent real relevance validation before any production adoption.

There is no automatic production activation even if a numerical gate passes.

## Results and error analysis

Metrics macro-average queries. Recall treats grades 2 and 3 as relevant; nDCG
uses gain `2^grade - 1`, matching the frozen evaluator. The script verifies exact
baseline order/nDCG parity with its recorded results.

| Method | Recall@1 | Recall@3 | nDCG@1 | nDCG@3 |
| --- | ---: | ---: | ---: | ---: |
| Actual lexical baseline | 0.3000 | 0.8000 | 0.5143 | 0.6991 |
| Actual hybrid baseline | 0.5000 | 1.0000 | 1.0000 | 0.9511 |
| Learned linear scorer | 0.5000 | 1.0000 | 1.0000 | 0.9511 |

Every query contains two relevant listings, so Recall@1 has a ceiling of 0.5.
Both hybrid and learned scorers place the grade-3 listing first in every heldout
query. They also tie on all ten domain slices: zero wins and zero losses.
The domain-cluster bootstrap interval for the observed nDCG@3 difference is
`[0, 0]`; that reflects identical sampled-domain results, not certainty about an
unseen population.

| Job-related slice | Queries | Hybrid nDCG@3 | Learned nDCG@3 |
| --- | ---: | ---: | ---: |
| Internship | 10 | 0.9586 | 0.9586 |
| Job | 10 | 0.9437 | 0.9437 |

The learned model preserves the hybrid's unresolved errors. In three queries
(documents/job and both warehouse modes), a grade-0 listing ranks above the
grade-2 listing. Sixteen queries retain a grade-0 listing in their top three,
displacing the generic grade-1 alternative. Lexical has twelve such top-three
errors, despite its substantially worse overall relevance ordering. This
illustrates why one error count is not a substitute for the full metric table.
The learner fixes none of these hybrid errors. Correlated features and this
small, incomplete training set do not support causal feature-importance claims.

No direct name, contact, age, gender, caste, religion, disability, photograph or
institution-prestige input is a learned feature. Counterfactual tests change
identity/protected metadata while preserving job evidence and verify unchanged
scalar/embedding inputs. **This is not demographic fairness evidence:** there
are no representative demographic annotations, and real project/summary text
can contain indirect proxies. Listing-mode slices describe these synthetic
workflows only; mode and experience are also correlated in the corpus.

## Runtime, cost and reproducibility

The recorded Apple M3 / Node 22.23.4 run built features in 9.425 ms and fitted
in 11.707 ms. Its 1,328-byte JSON model has four weights. Over 10,000 warmed
five-candidate reranks, learned P95 was approximately **0.000916 ms**, versus
hybrid **0.000292 ms**. These tiny local cached timings exclude embedding
generation, cold startup, source fetching and Worker execution; they do not
establish Cloudflare CPU headroom or concurrent capacity.

The experiment made **zero new model, embedding, search or Cloudflare requests**
and changed no production records. Hosted inference spend was zero; local
compute cost and the reused vectors' original inference cost were not newly
measured. There is no paid service, new dependency or model download.

From the repository root, with Node 22+ and existing Cloudflare dependencies:

```bash
npm ci --prefix cloudflare
node scripts/evaluate_reranker.mjs
npm --prefix cloudflare test -- tests/reranker-experiment.test.ts
```

The first command installs the existing project dependencies. The evaluator
itself rejects network access and accepts only root/output/model paths; it has
no tuning or live-provider switch. To preserve the recorded run while repeating:

```bash
node scripts/evaluate_reranker.mjs \
  --output /tmp/hireflow-reranker-repeat.json \
  --model /tmp/hireflow-reranker-repeat-model.json
```

Fourteen regressions cover policy/corpus/vector hashes, cross-split identities,
JD embargo, heldout-label independence, actual learning/determinism, metric
edge cases, invalid bounds and protected-metadata changes. A real subprocess
without provider credentials reproduces the model bytes, split and metrics.
Timings and run timestamps naturally vary.

The next useful experiment needs a new independently annotated corpus with
realistic negative examples, all relevance grades and user/posting/domain
separation, plus a genuinely blind evaluation. Predeclare a new policy/version
before fitting it. Retuning v1 on these published heldout results would not
establish an improvement.
