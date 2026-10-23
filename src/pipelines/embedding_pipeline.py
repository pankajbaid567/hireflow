"""
Embedding Pipeline

Generates vector embeddings for job descriptions and user profile text
using a sentence-transformers model. Builds and persists a FAISS index
for fast semantic similarity search.
"""

import argparse
import json
import logging
import os
import hashlib
import re
from uuid import uuid4
from pathlib import Path
from typing import Any

import numpy as np

from src.config.database import SessionLocal
from src.config.settings import get_settings

logger = logging.getLogger(__name__)

# Lazy imports to speed up module load and enable test mocking
_model = None
_model_name = None
_faiss = None


def _get_model():
    """Lazy-load the sentence-transformers model."""
    global _model, _model_name
    settings = get_settings()
    if _model is None or _model_name != settings.embedding_model:
        from sentence_transformers import SentenceTransformer
        logger.info(f"Loading embedding model: {settings.embedding_model}")
        _model = SentenceTransformer(settings.embedding_model)
        _model_name = settings.embedding_model
    return _model


def _get_faiss():
    """Lazy-load faiss."""
    global _faiss
    if _faiss is None:
        import faiss as faiss_lib
        _faiss = faiss_lib
    return _faiss


class EmbeddingPipeline:
    """
    Manages embedding generation and FAISS index operations.
    """

    def __init__(self, model=None):
        """
        Args:
            model: Optional pre-loaded SentenceTransformer model (used for testing).
        """
        self.settings = get_settings()
        self._model = model  # allow injection for tests
        self._index = None
        self._job_metadata: list[dict[str, Any]] = []

    def _model_instance(self):
        if self._model is not None:
            return self._model
        return _get_model()

    def embed_text(self, text: str) -> np.ndarray:
        """
        Embed a single string into a numpy vector.
        Handles empty/very short text gracefully by returning a zero vector.
        """
        if not text or not text.strip():
            # Return a zero vector of appropriate dimension
            model = self._model_instance()
            dim = model.get_sentence_embedding_dimension()
            return np.zeros(dim, dtype=np.float32)

        model = self._model_instance()
        vec = model.encode(text.strip(), convert_to_numpy=True)
        return vec.astype(np.float32)

    def semantic_scores(self, profile: dict, jobs: list, *, user_id: int,
                        profile_version: str, cache_root=None) -> dict[int, float]:
        """Use genuine model vectors and a request-scoped FAISS index.

        The private cache namespace includes model, algorithm, profile version,
        complete profile/JD fingerprints and job IDs. A changed source cannot
        reuse an old vector. This method is called by the normal scorer when
        explicitly enabled; missing optional model dependencies fail at its
        caller into an explicit lexical fallback. No download is attempted by
        default CI or by an ordinary disabled configuration.
        """
        if not isinstance(user_id, int) or user_id <= 0:
            raise ValueError("A private owner ID is required for semantic cache")
        if not jobs:
            return {}
        bounded = jobs[:200]
        query_text = profile_embedding_text(profile)
        if not query_text:
            return {}
        namespace = f"{self.settings.embedding_model}:native-pooling:profile-jd-v1"
        sources = [{"id": int(job.id), "title": job.title or "",
                    "description": job.description or "",
                    "listing_type": getattr(job.listing_type, "value", job.listing_type),
                    "location": job.location or ""} for job in bounded]
        signature = _fingerprint({"model": namespace, "profile_version": str(profile_version),
                                  "profile": profile, "jobs": sources})
        directory = Path(cache_root or self.settings.faiss_index_path) / "owners" / str(user_id)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        directory.chmod(0o700)
        manifest = directory / f"{signature}.json"
        vectors = None
        if manifest.is_file():
            try:
                data = json.loads(manifest.read_text())
                values = np.asarray(data["vectors"], dtype=np.float32)
                if (data.get("signature") == signature and data.get("model") == namespace
                        and values.ndim == 2 and values.shape[0] == len(bounded) + 1
                        and values.shape[1] > 0 and np.isfinite(values).all()
                        and np.all(np.linalg.norm(values, axis=1) > 0)):
                    vectors = values
            except (ValueError, TypeError, KeyError, OSError):
                pass
        if vectors is None:
            texts = [query_text, *[job_embedding_text(source) for source in sources]]
            vectors = np.asarray(self._model_instance().encode(texts, convert_to_numpy=True,
                                show_progress_bar=False), dtype=np.float32)
            if (vectors.ndim != 2 or vectors.shape[0] != len(texts)
                    or vectors.shape[1] == 0 or not np.isfinite(vectors).all()
                    or np.any(np.linalg.norm(vectors, axis=1) == 0)):
                raise ValueError("Embedding provider returned invalid vectors")
            temporary = manifest.with_suffix(f".{uuid4().hex}.tmp")
            with temporary.open("w") as stream:
                os.chmod(temporary, 0o600)
                json.dump({"signature": signature, "model": namespace,
                           "profile_version": str(profile_version),
                           "source_hashes": [_fingerprint(source) for source in sources],
                           "vectors": vectors.tolist()}, stream, separators=(",", ":"))
            os.replace(temporary, manifest)
            # Cache versions are recomputable and contain private vectors.
            # Bound disk use without touching PDFs or application history.
            old = sorted(directory.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
            for obsolete in old[32:]:
                obsolete.unlink(missing_ok=True)
        faiss = _get_faiss()
        documents = vectors[1:].copy(); query = vectors[:1].copy()
        faiss.normalize_L2(documents); faiss.normalize_L2(query)
        index = faiss.IndexFlatIP(documents.shape[1]); index.add(documents)
        scores, indices = index.search(query, len(bounded))
        return {int(bounded[int(index)].id): float(np.clip(score, 0, 1))
                for score, index in zip(scores[0], indices[0]) if index >= 0}

    def embed_jobs_to_index(self) -> int:
        """
        Fetch all non-spam jobs from the database, embed their descriptions,
        build a FAISS index and save it to disk.

        Returns:
            Number of jobs embedded.
        """
        from src.models.job import Job

        db = SessionLocal()
        try:
            jobs = db.query(Job).filter(Job.is_spam == False).all()  # noqa: E712
            logger.info(f"Embedding {len(jobs)} non-spam jobs...")
            if not jobs:
                logger.warning("No non-spam jobs found in database.")
                return 0

            texts = []
            metadata = []
            for job in jobs:
                # Combine title + description for richer semantic content
                text = f"{job.title or ''} {job.description or ''}".strip()
                texts.append(text)
                metadata.append({
                    "id": job.id,
                    "role_title": job.title,
                    "company_name": job.company,
                    "location": job.location,
                    "url": job.url,
                    "listing_type": job.listing_type.value if job.listing_type else "job",
                })

            model = self._model_instance()
            embeddings = model.encode(texts, convert_to_numpy=True, show_progress_bar=True)
            embeddings = embeddings.astype(np.float32)

            # Build a flat L2 FAISS index
            faiss = _get_faiss()
            dim = embeddings.shape[1]
            index = faiss.IndexFlatIP(dim)  # Inner Product (cosine after normalisation)
            faiss.normalize_L2(embeddings)
            index.add(embeddings)

            # Persist index and metadata to disk
            self._save_index(index, metadata)
            self._index = index
            self._job_metadata = metadata

            logger.info(f"FAISS index built with {index.ntotal} vectors.")
            return len(jobs)
        finally:
            db.close()

    def _save_index(self, index, metadata: list[dict]) -> None:
        """Save FAISS index and job metadata JSON to the configured path."""
        faiss = _get_faiss()
        path = self.settings.faiss_index_path
        os.makedirs(path, exist_ok=True)
        faiss.write_index(index, os.path.join(path, "jobs.index"))
        with open(os.path.join(path, "jobs_metadata.json"), "w") as f:
            json.dump(metadata, f)
        logger.info(f"FAISS index saved to {path}/")

    def load_index(self) -> bool:
        """
        Load FAISS index and metadata from disk.

        Returns:
            True if loaded successfully, False if files not found.
        """
        faiss = _get_faiss()
        path = self.settings.faiss_index_path
        index_path = os.path.join(path, "jobs.index")
        meta_path = os.path.join(path, "jobs_metadata.json")

        if not os.path.exists(index_path) or not os.path.exists(meta_path):
            logger.warning(f"FAISS index not found at {path}/. Run --embed-jobs first.")
            return False

        self._index = faiss.read_index(index_path)
        with open(meta_path) as f:
            self._job_metadata = json.load(f)
        logger.info(f"Loaded FAISS index with {self._index.ntotal} vectors.")
        return True

    def search(self, text: str, top_k: int = 5) -> list[dict[str, Any]]:
        """
        Embed a query string and return the top-K most similar jobs.

        Args:
            text: Profile or query text to search with.
            top_k: Number of results to return.

        Returns:
            List of job metadata dicts with an added 'score' key.
        """
        if top_k <= 0:
            return []
        if self._index is None:
            loaded = self.load_index()
            if not loaded:
                return []

        query_vec = self.embed_text(text)

        # Handle zero vector (empty input)
        if np.all(query_vec == 0):
            logger.warning("Empty query text — returning no results.")
            return []

        faiss = _get_faiss()
        query_vec = query_vec.reshape(1, -1).astype(np.float32)
        faiss.normalize_L2(query_vec)

        k = min(top_k, self._index.ntotal)
        scores, indices = self._index.search(query_vec, k)

        results = []
        for score, idx in zip(scores[0], indices[0]):
            if idx < 0:  # FAISS returns -1 for empty slots
                continue
            job = dict(self._job_metadata[idx])
            job["score"] = float(score)
            results.append(job)

        return results


def _fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    separators=(",", ":"), default=str).encode()).hexdigest()


def _private_facts(value: str) -> str:
    value = re.sub(r"https?://\S+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b", " ", value, flags=re.I)
    value = re.sub(r"(?:\+?\d[\s().-]*){9,}", " ", value)
    return re.sub(r"\s+", " ", value).strip()[:1800]


def profile_embedding_text(profile: dict) -> str:
    """Only approved technical/profile facts; contact identity is not a signal."""
    skills = ", ".join(str(value) for value in (profile.get("skills") or [])[:100])
    roles = ", ".join(str(value) for value in (profile.get("target_roles") or [])[:100])
    values = [f"Skills: {skills}" if skills else "", f"Target roles: {roles}" if roles else "",
              str(profile.get("summary") or "")]
    for project in (profile.get("projects") or [])[:8]:
        if isinstance(project, dict):
            values.extend([str(project.get("name") or ""), str(project.get("description") or ""),
                           *[str(value) for value in (project.get("tech") or [])[:100]]])
    return _private_facts(". ".join(value for value in values if value))


def job_embedding_text(job: dict) -> str:
    return _private_facts(". ".join(str(job.get(key) or "") for key in ("title", "description") if job.get(key)))


def main():
    """CLI entry point."""
    parser = argparse.ArgumentParser(description="HireFlow Embedding Pipeline")
    parser.add_argument(
        "--embed-jobs",
        action="store_true",
        help="Embed all non-spam jobs and build FAISS index",
    )
    args = parser.parse_args()

    if args.embed_jobs:
        pipeline = EmbeddingPipeline()
        count = pipeline.embed_jobs_to_index()
        print(f"\nDone. Embedded {count} jobs into the FAISS index.")
        settings = get_settings()
        print(f"Index saved to: {settings.faiss_index_path}/")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
