# Resume PDF quality and intake coverage

This source release improves the actual Worker renderer and the Python plan's
ReportLab renderer. It does not claim support for every script, OCR, or every
ATS parser. Publication and the production application cycle are recorded in the
release verification separately.

## What changed

The Worker keeps its small Helvetica/WinAnsi ASCII path. Accented names and
Latin/Greek/Cyrillic text use an embedded Unicode TrueType font; Devanagari uses
OpenType shaping with correctly positioned matras and conjuncts. Pre-subset Noto
fonts include a Unicode CMap and logical `/ActualText`, so both visual reading
and actual text extraction retain names such as `Zoë D'Souza` and `किरण शर्मा`.
NFC normalization preserves letters; common decorative punctuation is normalized
without stripping accents or replacing unsupported names with spaces.

Wrapped URLs retain the complete original HTTP(S) target. Non-ASCII URI targets
are encoded safely; credential-bearing or script URLs are never emitted as PDF
actions. Long words wrap at grapheme boundaries, and section/entry continuation,
page numbers and the existing 800-line guard preserve complete supported facts.
Unsupported scripts/symbols fail visibly and retain the original PDF/profile.
The Worker additionally bounds complex-script work to **384 rendered characters
per resume**, including repeated continuation headings; longer native-language
resumes need the original PDF or a shorter explicitly reviewed version. This is
a free-runtime bound, not silent truncation or a universal-language claim.

The Python normal plan uses bundled Unicode fonts and ReportLab/HarfBuzz
shaping. It retains profile links, aliases, education/GPA, project and experience
details, certifications, achievements and languages. Hindi paragraphs can
include ASCII technical terms; a paragraph mixing Hindi with unsupported
non-ASCII script/font combinations fails visibly. Its optional LLM summary path
accepts only verbatim source sentences and rejects unsupported credentials or
experience. The original optional LaTeX helper delegates Unicode/richer schemas
to the same renderer, escapes text in one pass, validates file identifiers and
HTTP(S) links, and disables LaTeX shell escape. The legacy ASCII template remains
an optional XeLaTeX path rather than a prerequisite for the normal plan.

Python intake explicitly reads logical `/ActualText`, since pypdf alone can
return visual glyph order for shaped Indic text. Intake is bounded to 10 MB,
20 pages and 100,000 extracted characters. Encrypted, malformed and no-readable-
text PDFs produce clean errors. **Python does not perform OCR**: image-only
uploads are rejected before a model request or profile/file write. Cloudflare
uses Gemini's multimodal PDF input; the text-based probes below do not establish
scanned-document/OCR quality or universal layout accuracy.

## Fonts, privacy and reproducibility

`assets/fonts/manifest.json` records the pinned official Noto commit, source and
subset SHA-256 hashes, supported ranges and sizes. The renamed subsets are
238,528 and 196,216 bytes, distributed with `assets/fonts/OFL.txt`. No proprietary
system font is copied. See the upstream [Noto license](https://github.com/notofonts/noto-fonts/blob/ffebf8c1ee449e544955a7e813c54f9b73848eac/LICENSE)
and [fontkit API](https://github.com/foliojs/fontkit).

Runtime subsetting is avoided. Font streams, widths and descriptors are prepared
from public static font data at isolate initialization. `fontkit` is pinned to
**2.0.4**. Its processors retain their last glyph run internally, so a tested
adapter gives every document its own glyph cache and layout/GSUB/GPOS processors,
sharing only the prewarmed parsed font tables. A regression verifies that two
synthetic names leave the static template's glyph cache and processor sequence
unchanged. Upgrading fontkit requires revisiting this private-API adapter and
running the isolation, reader and workerd checks; a version range is unsafe.

To rebuild the public assets, install `fonttools==4.67.0` in a development
virtualenv and run `venv/bin/python scripts/build_resume_fonts.py`. Rebuilds
verify pinned source hashes. FontTools is not a runtime dependency. Python
runtime installation requires ReportLab 4.4+ and uharfbuzz; Docker copies the
bundled font assets for its unprivileged runtime user.

A sanitized [machine-readable evidence report](evidence/p1-pdf-quality.json) is
committed with source/corpus hashes, reader results and the actual-provider
probe outcomes. Private local PNG/PDF artifacts remain outside Git.

## Offline reader and visual evidence

`tests/fixtures/pdf_quality/profiles.json` contains **eight synthetic profiles**:
sparse student, accented names, Hindi, long experience, unbroken URLs, schema
variants, symbols/numbers and combining marks/newlines. All contacts use
`example.com`; no real resume is in the corpus. Expected and forbidden facts
are declared separately from generated outputs.

On 23 October 2026, `/tmp/hireflow-p1-pdf-quality/proof.json` passed for **16 PDFs**
(eight per runtime): zero missing required facts in Poppler and Python intake,
zero forbidden invented facts, no missing link targets and no words outside the
page bounds. All **19 pages** were rendered to PNG. The five-role/35-bullet case
retained its first and last checkpoints across two Worker pages and three Python
pages. Coding-agent visual inspection covered both runtimes' Latin/Hindi,
multi-page continuation, schema and long-link layouts, with no visible clipping,
missing glyphs, overlaps or orphaned section headings. This is not an independent
human quality review.

```bash
# Node 22+, project dependencies, Python virtualenv and Poppler required.
node scripts/verify_resume_pdf_quality.mjs
cd cloudflare
npm test -- tests/pdf.test.ts tests/pdf-quality.test.ts
cd ..
venv/bin/python -m pytest tests/test_pdf_quality.py tests/test_pdf_generator.py tests/test_profile_api.py -q
```

The focused coordinated runs passed **26 Worker PDF tests** and **38 Python
PDF/profile tests**. CI installs Poppler for the Worker reader regressions;
Python tests use real ReportLab/pypdf without requiring a model or LaTeX. The
negative controls cover unsupported scripts, image-only input, encryption,
excess pages, URI/code injection and a fabricated optional-provider summary.

## Actual Gemini PDF probes

`/tmp/hireflow-p1-pdf-extraction-live/proof.json` passed **three synthetic PDF
probes** in actual workerd: a two-column layout, a three-page history and a Hindi
profile. All three returned HTTP 200, **100% declared critical-field recall**
(name, email and supplied skills), all declared project/education/last-history
fact checks and zero listed fabricated credentials. These are small explicit
checks, not a broad extraction-accuracy benchmark or proof that every fact in
every PDF is recognized.

Each configured `gemini-3.8-flash` attempt timed out and the existing bounded
recovery used **`gemini-3.5-flash-lite`** successfully. Total per-document latency
was **30.495 s / 31.219 s / 28.680 s**. The evidence records the actual fallback,
not a primary-model success. No provider file upload was needed (each input was
below 32 KB), no DB/application/queue/email was written, and no OCR claim is made.

```bash
# Explicit opt-in; three synthetic documents, configured models/keys only.
node scripts/verify_resume_pdf_extraction_live.mjs --run-live
```

## CPU evidence and limits

Local actual-workerd CDP sampling is in
`/tmp/hireflow-p1-capacity/pdf-{ascii,latin,hindi-after}.json`. For 50 requests,
ASCII/Latin/Hindi sampled active averages were **0.506/1.155/2.689 ms**. Hindi
sampling dropped from 3.729 to 2.689 ms after static font-stream preparation;
wall P95 dropped from 7.091 to 3.713 ms. These are **local active samples and
wall times**, not Cloudflare billed CPU. The first post-ready Hindi dispatch
still took 11.894 ms wall time; it is not a startup-CPU measurement. See
[capacity evidence](p1-capacity.md) and actual post-deployment platform metrics
before interpreting these as free-tier headroom or sustainable throughput.
