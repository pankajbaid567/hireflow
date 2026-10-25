# Private preparation exports

The Cloudflare path exports a **saved guide** into standalone HTML and PDF.
It includes interview rounds, topic groups and evidence, learning resources,
mock questions, company claims/citations, news, interview evidence, warnings and
generation time. Exporting does not call an LLM, research the company again,
send email or authorize an application.

## API and privacy

All routes require the application's owner session. Knowing an application or
export UUID is insufficient. Responses use `Cache-Control: no-store`; HTML has
a restrictive CSP and escaped content, and links accept public HTTP(S) only.

| Method and route | Behavior |
| --- | --- |
| `POST /applications/{id}/prep-guide/exports` | Returns a durable `202` ticket, or `200` for an unchanged ready snapshot. Optional `{ "regenerate": true }` explicitly creates another version. |
| `GET /applications/{id}/prep-guide/exports` | Latest metadata and up to twenty version summaries. No object keys or captured guide JSON are exposed. |
| `GET /applications/{id}/prep-guide/exports/{uuid}` | Poll `queued`, `running`, `ready`, `failed` or `expired`. |
| `GET .../{uuid}/html` / `GET .../{uuid}/pdf` | Owner-authenticated immutable artifacts. Pending/failed:409; expired:410; absent/deleted:404. |

Each version binds guide ID/revision, captured profile version, listing facts
version and original guide-generation profile/listing versions. Legacy guides
with missing generation versions say **unknown**, rather than inferring them.
Submitted applications use their historical listing snapshot. A later profile
or guide change marks old downloads `stale`; explicit old versions remain
available until expiry with their original content. Exporting an old guide for
a newer profile remains labelled stale and does not regenerate its advice.

Resources/citations preserve the saved guide's validation and source dates.
The exporter checks link syntax/safety and makes links clickable in HTML and PDF;
it does **not** claim a fresh availability check. Predictions, estimates,
undated/historical reviews and missing company evidence retain their labels.

## Queue, bounds and lifecycle

Migration `0014_prep_exports.sql` creates owner-linked `prep_guide_exports` and
adds guide revision/source-version metadata. POST only captures a bounded
snapshot and dispatches `{kind:"prep_export",export_id}`. Queue work renders
both formats; an atomic claim makes duplicate deliveries harmless. Publication
rechecks ownership, profile, guide revision and listing facts after file writes.
Concurrent changes or partial storage failure clean both new files and produce
a sanitized failure, leaving the saved guide and older exports untouched.

Work has a five-minute deadline. Maintenance redispatches undispatched tickets,
fails abandoned work and removes failed/expired files in bounded batches.
Rendering failures require an explicit new version; there is no blind render
retry loop. Three new export requests per application/ten minutes are allowed;
safe reuse of an existing active/ready snapshot does not normally spend another
render. Artifacts expire after thirty days. The UI shows progress, safe failure
reasons, stale snapshots, versioned downloads and explicit replacement controls.

Files use immutable private keys
`prep-guides/{user_id}/{application_id}/{export_uuid}.{html,pdf}`. Account/app
deletion and backup/restore must collect these keys before cascading rows.
`latestPrepGuideExports` is an internal report/email helper: its storage keys
must never be copied into public report JSON. Reports should publish only the
authenticated `html_url`/`pdf_url`, version and stale state.

PDF generation uses a dedicated A4 document layout, accurate core-font metrics,
per-document embedded Latin/Devanagari fonts, complete wrapping, page numbers
and PDF URI annotations. Bounds are explicit:150KB captured snapshot,120KB
rendered document description,200 paragraphs,1,000 wrapped lines,2MiB PDF and
the shared384 complex-script-character limit. Unsupported/excessive content
fails visibly; no facts are silently removed. This is text PDF support, not OCR
or unrestricted language/font coverage.

## Verification

`cloudflare/tests/prep-exports.test.ts` runs actual workerd, D1, R2 and the real
Queue handler with14 scenarios: complete content/Unicode/link extraction,
duplicate delivery, immutable/stale versions, historical generation metadata,
profile/guide/JD upload races, ownership, expiry/deleted files, queue recovery,
abandoned work, partial writes, unsafe content and explicit request limits.
No provider/employer requests or real email are made.

`frontend/src/test/prep-exports.test.jsx` adds five UI checks for explicit
creation/polling, private links, version/stale display, expired/failed replacement
and retry after API errors. Guide evidence/refresh UI has separate coverage.

Synthetic two-page and six-page PDFs were opened with Poppler/pypdf, all eight
rendered pages visually inspected, and final fact markers/URL annotations
verified. Hindi logical extraction is checked through PDF `ActualText` with
Poppler; pypdf also checks page/URI structure. The samples are private local QA
artifacts, not production or fresh external-resource validation evidence.
