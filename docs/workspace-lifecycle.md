# Workspace backup, restore and retention

HireFlow exports private candidate data and immutable documents together. It
does not export a login session or an authorization to submit applications or
send email. The normal deployment still uses the existing free D1/private-KV
bindings; R2 is supported when already configured and is not activated here.

## Owner export

Open **Profile → Weekly automation and workspace data → Create private backup**
on the canonical Pages website. An authenticated, same-origin request creates
an owner-scoped Queue job. Status polling and each document download require
that same workspace's authenticated access; knowing an export UUID is not
authorization. Responses use `private, no-store` and attachment downloads.

Keep this directory structure together:

```text
private-export/
  manifest.json
  snapshot.json
  artifacts/
    0.bin
    1.bin
    ...
```

The UI displays a **manifest SHA-256**. Save it separately from the downloaded
files. Document ordinals start at zero. The manifest contains each original
private document reference, purpose, byte length and SHA-256; it does not expose
internal backup storage keys. These files contain private resume/application
information: use a private directory and do not add them to Git or public demos.

The metadata snapshot includes the profile, linked listings, applications,
status history, resume versions/profile provenance, prep guides, completed
guide-export files, weekly reports and shortlists. Historical master resume
uploads referenced by immutable resume versions are included too. Failed,
expired and unfinished guide-export metadata is retained, but unpublished or
already-cleaned guide files are not represented as complete artifacts.

Sessions, transfer links, passkeys, recovery keys, reviews/approval bindings,
browser checkpoints, outbox work, active plan/discovery/prep leases, schedules,
reminders and email-delivery authority/payloads are excluded. Global provider,
search, embedding and browser usage counters are never reset or exported as
restorable workspace authority.

The D1 reads form a transactional snapshot. A conservative SQL byte/count
preflight runs before loading bulk rows; revision checks reject concurrent
changes between preflight and capture. Document copies use immutable source
keys and one bounded file per Queue step. A missing source file produces a
failed export instead of a misleading complete archive. With KV, allow recent
writes to become visible before retrying. Wait for current preparation to
finish if the workspace is changing rapidly.

Free-deployment bounds are explicit: **4 MiB metadata, 4 MiB per file, 32 MiB
total document bytes and 256 files**, plus per-table row caps. Larger workspaces
fail with an operator-backup instruction; no records are silently truncated.
At most two exports are admitted globally per UTC day, including failed
attempts. Copies expire after **48 hours**. Download every needed file before
then; an expired export is not a disaster-recovery promise.

## Offline restore drill

Install the project's locked Cloudflare dependencies and use Node 22+. Restore
only a private export whose manifest hash you obtained from authenticated
status. The destination must not exist:

```bash
node scripts/restore_workspace_backup.mjs \
  --run-isolated-restore \
  --archive /absolute/path/private-export \
  --destination /absolute/path/new-isolated-restore \
  --manifest-sha256 THE_SEPARATELY_SAVED_64_HEX_DIGEST
```

This CLI starts **local Miniflare D1 and private KV**. It has no remote mode,
Cloudflare account credential, provider call or production binding. It rejects
archive symlinks, oversized entries, an existing destination and a non-empty
destination database. Artifacts are read and verified one at a time; no 32-MiB
base64/JSON file bundle is created in a Worker. The destination directory is
0700; the ID/file mapping and restore receipt are private files.

The actual database and KV bytes persist under `DESTINATION/state` through
Miniflare 5's `resourcePersistencePath`. Retain this directory together with
`mapping.json`; a receipt alone is not recovered data. The CLI regression starts
a second process after restore exits, reopens that same state without importing
or applying migrations, and verifies application/status history, resume
versions, every artifact hash and empty authentication/outbox tables.

Manifest, metadata and document hashes must match before rows are committed.
The database import is transactional and uses an isolation guard. On a failed
import, newly copied files are removed; source files are never modified. Owner,
job, application, guide and artifact references receive new destination IDs.
Original status-history timestamps and PDF version bytes/hashes are preserved.

Historical `applied`, interview and outcome records remain historical.
`confirmed`/`applying` records become `needs_action`: check the employer site
before attempting anything else. Drafts require a fresh PDF/review. Unfinished
guide exports become failed and require an explicit new request. No sessions,
passkeys, recovery keys, reviews, checkpoints, queue leases, schedules or email
deliveries are restored, and no outbound task is enqueued.

This produces a **data recovery workspace**, not an authenticated production
account migration. A production cutover requires separately verified owner
provisioning and passkey enrollment; there is no email-only recovery endpoint.
Archived report HTML is preserved byte-for-byte, so embedded old application
links can refer to old IDs. Structured report links are remapped; generate a
fresh report after an authorized migration for current HTML links.

The automated drill uses actual local D1/R2 source records, a separate restored
D1/R2 workspace and a real CLI run into private KV:

```bash
npm --prefix cloudflare test -- tests/workspace-backup.test.ts
```

It covers exact PDF hashes/versions/history, cross-user negatives, tampering,
non-empty destination refusal, bounded inputs, current KV behavior, nonce
binding, scoped deletion and publication/garbage-collection races. It sends no
real application or email. A local drill does not establish production restore
latency or a recovery SLA.

## Deletion is separate consent

**Preview deletion** shows current domain/auth/workflow record counts, document
counts, shared artifacts that will be retained, and whether submitted history
is included. Export/download first if needed. The owner must type
`DELETE MY WORKSPACE` and submit the fresh preview nonce/profile version.
The five-minute nonce is one-use and bound to the same authenticated session
and workspace revision. Changes, expiry or another session require a new
preview. Active submissions/exports or an in-flight email send block deletion.

The Queue atomically checks the revision and removes that owner's database
rows before removing the recorded unreferenced files. Submitted evidence is
included only in this explicit workspace-deletion consent; ordinary retention
must preserve it. Other owners and shared global listings/usage counters are
not removed. Application access is revoked with the owner/session rows.
Document cleanup proceeds in bounded Queue steps and can retry; a 202 response
means **queued**, not proof that every storage operation has finished. Deleting
HireFlow cannot withdraw an already submitted employer application or an
already transmitted email.

## Retention and safe orphan cleanup

Production orphan/expired-backup cleanup is **not enabled by this change**.
`cleanupWorkspaceOrphans()` and `expireWorkspaceBackupArtifacts()` default to
dry-run; an operator must explicitly enable execution after reviewing the
isolated drill and deployment storage policy.

Orphan discovery processes ten keys from one native KV/R2 list page. It limits
scope to HireFlow document prefixes and first records an unreferenced candidate.
The key must remain unreferenced for at least **seven days after first
observation** before deletion is eligible; missing legacy upload timestamps
never imply an old creation date. Current and historical master uploads,
resume versions, submitted/reviewed PDFs, report/guide keys, active backup
sources and email-selected sources are protected.

A D1 tombstone is claimed only when all live references are absent. Publication
triggers refuse a retired key, preventing a late writer from attaching it
between the last reference check and the KV/R2 delete. Writers generate new
immutable keys; they must not resurrect a tombstoned path. Cleanup never scans
arbitrary namespaces or resets actual provider/browser/account usage. Archived
backup copies are eligible only after their own expiry and an independent
reference check. Privacy-sensitive failure states stay private and do not log
resume content, credentials, raw cookies or artifact names.

## Schema rollback and hosting migration

Apply the ordered migrations before the matching Worker release. New lifecycle
tables/triggers are additive, but an older Worker cannot safely use a database
whose artifact-retirement rules it ignores. Keep the previous tested Worker
version and schema compatibility matrix before deployment; rehearse rollback
against a copied/isolated dataset. Prefer a forward repair for data/schema
changes rather than blindly dropping columns or replaying outbound work.

Cloudflare's [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
is a database recovery tool; it does not restore private KV/R2 documents.
Coordinate the database recovery point with retained, hashed document copies
and separately protected authentication recovery. The documented
[D1 limits](https://developers.cloudflare.com/d1/platform/limits/) and
[KV limits](https://developers.cloudflare.com/kv/platform/limits/) constrain
batch size, row size, storage and daily operations. These archive bounds do not
increase any paid allowance.

Keep the old Vercel bridge while users, credentials or links still need it.
Before retirement, verify the canonical Pages origin, cookie transfer/passkey
behavior, CORS, authenticated document links, complete restore drill,
deployment rollback and the actual migration inventory. Communicate the date
and recovery steps to affected users and maintain a checked redirect/transfer
period. Do not delete the bridge or enable R2 billing as a shortcut. Neither is
performed by this lifecycle implementation.
