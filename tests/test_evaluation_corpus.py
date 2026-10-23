"""Guard consent, heldout separation and the frozen real-model artifacts."""
from pathlib import Path
import hashlib
import json


ROOT = Path(__file__).resolve().parents[1] / "evals" / "hireflow_v1"


def test_frozen_corpus_has_distinct_cases_and_ranking_domain_holdout():
    raw = (ROOT / "cases.jsonl").read_bytes()
    cases = [json.loads(line) for line in raw.decode().splitlines()]
    manifest = json.loads((ROOT / "manifest.json").read_text())
    assert hashlib.sha256(raw).hexdigest() == manifest["sha256"]
    assert len(cases) == len({case["id"] for case in cases}) == 120
    ranking = [case for case in cases if case["kind"] == "ranking"]
    dev = {case["group"] for case in ranking if case["split"] == "dev"}
    heldout = {case["group"] for case in ranking if case["split"] == "heldout"}
    assert dev and heldout and dev.isdisjoint(heldout)
    assert manifest["hybrid_alpha"] == .2
    assert "not independently human" in manifest["label_author"]
    for case in cases:
        for profile in [case.get("profile"), case.get("expected")]:
            if profile and "email" in profile:
                assert profile["email"].endswith("@example.com")


def test_vectors_are_real_model_revisioned_and_match_frozen_source_inputs():
    data = json.loads((ROOT / "bge_cls_vectors.json").read_text())
    assert data["model"] == "BAAI/bge-small-en-v1.5"
    assert data["pooling"] == "cls"
    assert data["revision"] == "5c38ec7c405ec4b44b94cc5a9bb96e735b38267a"
    assert data["corpus_sha256"] == hashlib.sha256((ROOT / "cases.jsonl").read_bytes()).hexdigest()
    assert len(data["vectors"]) == 48 * 6
    assert all(len(vector) == 384 for vector in data["vectors"].values())
    assert set(data["vectors"]) == set(data["input_sha256"])
