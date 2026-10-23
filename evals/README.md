# HireFlow quality evaluation

Start with [the evaluation design, results and limitations](../docs/ai-evaluation.md).
The 120-case corpus is entirely synthetic, with domain-separated ranking splits,
frozen thresholds and genuine BGE model vectors. Default evaluation calls actual
Worker functions without hosted inference. Provider runs require explicit flags.

- `hireflow_v1/cases.jsonl`: source inputs, relevance/factual labels and label basis.
- `hireflow_v1/manifest.json`: corpus digest, split policy and predeclared gates.
- `hireflow_v1/source_support_fixtures.json`: controlled positive/missing/stale/future/broken-source scenarios; no network.
- `hireflow_v1/bge_cls_vectors.json`: public synthetic genuine-model output,
  revision/pooling/input hashes; no production data.
- `results/offline.json`: actual-function comparison and per-case errors/metrics.
- `results/live-tailoring.json`: two actual Groq source selections, separately scoped.
- `results/extraction-live-baseline.json` and `extraction-live.json`: retained actual
  before/after fixed-subset extraction evidence, including the original error.

Run `node scripts/run_ai_evaluation.mjs` with Node22+ and installed Cloudflare
package dependencies. To reproduce model inference use
`PYTHONPATH=. venv/bin/python evals/embed_corpus.py`; to reproduce actual text
extraction use `PYTHONPATH=. venv/bin/python evals/run_live_extraction.py --run-live`.
No independent human ratings, live source precision or hiring outcome benchmark
is claimed. The human rubric and review protocol are documented for that work.
