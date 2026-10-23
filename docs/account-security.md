# Account ownership and recovery

HireFlow protects private profiles, resumes, applications and reports with an
HttpOnly browser session. A profile number or email address is not a credential.
Email addresses are profile contact details; HireFlow does not verify email
ownership or send account recovery email.

## Save a recovery method

While signed in, open **Profile → Account security and recovery**. Add a passkey
on the Cloudflare dashboard, and save recovery keys in a password manager or
another private place before signing out or clearing browser data.

The signed-out profile page keeps recovery under **Already have a workspace?
Sign in**. Open that section to use a saved passkey or recovery key. Ordinary
profile creation does not ask for a password or server operator code.

| Capability | Cloudflare Worker | Python/FastAPI |
| --- | --- | --- |
| Private owner session | Yes | Yes |
| Passkey enrollment and sign-in | Yes | No; API reports `capabilities.passkeys: false` |
| Single-use recovery keys | Yes | Yes |
| List and revoke sessions | Yes | Yes |
| Email or numeric-ID sign-in | No | No |

Without a saved recovery method or an existing signed-in browser, HireFlow
cannot prove account ownership from an email address alone. For a local Python
installation, an operator with existing filesystem/database access can use the
offline procedure below. There is no unauthenticated HTTP equivalent.

## Cloudflare passkeys

The implementation pins `@simplewebauthn/server` and
`@simplewebauthn/browser` to 14.0.0. It requests discoverable ES256 credentials
and requires authenticator user verification during enrollment and sign-in.
Enrollment requires an existing owner session. HireFlow stores the credential
ID, public key, counter, transport information, user-assigned name and usage
timestamps. It does not receive device biometrics or the private key.

Sign-in verifies a signed assertion against the stored credential, expected
challenge, origin and relying-party ID. Challenges expire after five minutes,
are tied to a separate HttpOnly ceremony cookie and are consumed on a verification
attempt. Enrollment challenges are also bound to the current owner session.
Each workspace can register up to ten passkeys. A fresh browser can use a
previously registered passkey available through its authenticator or passkey
provider; copying a profile ID does not restore access.

See the maintained [SimpleWebAuthn server documentation](https://simplewebauthn.dev/docs/packages/server)
and [passkey configuration guide](https://simplewebauthn.dev/docs/advanced/passkeys/).

Configure the Worker using the canonical dashboard origin:

```text
PUBLIC_BASE_URL=https://hireflow-dashboard.pages.dev/api
ALLOWED_ORIGINS=https://hireflow-dashboard.pages.dev
WEBAUTHN_RP_ID=hireflow-dashboard.pages.dev
```

`WEBAUTHN_RP_ID` is optional and defaults to the hostname in `PUBLIC_BASE_URL`.
An explicit value must match that hostname exactly. `ALLOWED_ORIGINS` can contain
additional comma-separated approved origins, but account security mutations
and passkey ceremonies require the canonical `PUBLIC_BASE_URL` origin. Use HTTPS
in production; HTTP localhost is supported for development. Passkeys belong to
their relying-party domain, so use the stable canonical dashboard rather than a
temporary preview hostname. An origin change requires a planned account
migration rather than silently treating another domain as the same relying party.

Pages forwards account requests and cookies to the API through its same-origin
`/api/` proxy. The server-held profile bootstrap credential is not an account
recovery credential and is never requested by the recovery UI.

## Recovery keys and sessions

Both runtimes generate eight keys per rotation. Each key contains 256 bits of
cryptographic randomness, can be used once, and expires after one year. Only
SHA-256 hashes are stored in the database. Raw keys are returned once to the
authenticated owner, displayed in component memory, and hidden when the owner
selects **I saved these keys**. They are not saved to browser local storage or
emailed. Replacing the keys invalidates all previous keys.

Successful key recovery consumes the key, revokes existing owner sessions, and
creates the replacement session in one database transaction. In Cloudflare it
also revokes outstanding workspace transfers and enrollment challenges. A failed
replacement-session write leaves the old sessions and key intact. Concurrent
uses of the same key allow one successful recovery. Recovery and passkey sign-in
attempts are rate limited; repeated attempts return a safe error without exposing
another account's details.

Owner sessions last 30 days. Cookies are HttpOnly, SameSite Lax and Secure on
production HTTPS. Only hashes of the random session tokens are stored. Account
security lists device labels, creation/expiry dates and which session is current;
it never returns token hashes or raw tokens. **Sign out** revokes the selected
session. **Sign out all devices** revokes all owner sessions; a saved passkey or
unused recovery key can restore access afterward.

Five-minute workspace transfer links are bound to the signed-in session that
created them. Signing out or revoking that session invalidates its outstanding
links. Transfer consumption checks that source session and creates the new
session atomically; a storage failure does not spend the link. Links minted
before migration 0004 have no source binding and are rejected. Their owners can
create a new link from an existing signed-in browser; existing sessions are
preserved by the migration.

## Database setup

Apply migrations before starting the corresponding API. Cloudflare migration
`0004_account_security.sql` extends session metadata and adds passkey, challenge,
owner-handle and recovery-key tables. It preserves existing valid sessions.
Subsequent migrations must also be applied in order:

```bash
cd cloudflare
npm ci
npm run db:local
# On an authorized deployment, apply every pending remote migration:
npm run db:remote
```

For Python, Alembic revision `004` follows `003` and creates `auth_sessions`,
`account_recovery_keys` and `account_attempts`:

```bash
venv/bin/python -m alembic upgrade head
```

Python profile creation issues an owner session. Existing databases created
before owner sessions do not gain access through a previously cached numeric ID.
On a machine where the operator already has database access, generate keys for
an existing owner with:

```bash
venv/bin/python -m src.api.security --user-id EXISTING_USER_ID
```

This command invalidates previous recovery keys and prints the new keys once.
Run it privately, save the output securely, and do not paste keys into issues,
logs, screenshots or this repository. The command does not authenticate anyone
over HTTP and does not verify an email address. Configure Python
`ALLOWED_ORIGINS` for the dashboard origin and use `APP_ENV=production` on a
public HTTPS deployment so cookies remain Secure behind a reverse proxy.

## API and verification

Both runtimes expose `GET /session`, `POST /session/logout`,
`GET /account/security`, `POST /account/recovery-keys/rotate`,
`POST /account/recover`, `DELETE /account/sessions/{session_id}` and
`POST /account/sessions/revoke-all`. Recovery accepts only
`{"recovery_key":"..."}` as its credential. The Cloudflare runtime additionally
exposes authenticated passkey enrollment/removal and public challenge/assertion
sign-in endpoints under `/account/passkeys/`.

Run the focused verification locally with Node 22 or later and the installed
Playwright Chromium browser:

```bash
cd cloudflare
npm test -- tests/account-security.test.ts tests/session_transfer.test.ts
cd ..
venv/bin/python -m pytest tests/test_account_security.py -v
node scripts/verify_account_security.mjs
```

The browser script starts isolated local Miniflare/D1/KV and a local dashboard.
It uses Chromium virtual authenticators to verify enrollment, a signed passkey
assertion from a second cookie-free browser, one-use recovery from a third
browser, replay rejection and session revocation. It loads no provider keys and
makes no real employer submissions. Workerd tests also cover forged signatures,
cross-origin/cross-user requests, expiry, concurrency and storage rollback.
The security migration was applied with the P0 deployment on 23 October 2026.
The explicit production browser check also passed: enrollment, second-context
signed passkey assertion, third-context recovery key, replay rejection, prior
session revocation and sign-out-all. Proof:
`/tmp/hireflow-account-security-live/1cd5a49d3f11/proof.json`. Virtual credential
sync exercises real signature verification; it does not certify every physical
authenticator or prove email ownership. See [release evidence](p0-verification.md).

After an authorized deployment, `node scripts/verify_account_security_live.mjs
--run-live` performs the same account-only flow against the canonical Pages
dashboard with one fresh synthetic manual profile. The explicit flag is required.
It does not upload a resume, call a model, search for jobs, send email or submit to
an employer. Sanitized proof is written below `/tmp/hireflow-account-security-live/`
with private file permissions. Only the synthetic owner ID, fake email, stages
and outcomes are retained; keys, cookies and authenticator private data stay in
memory. The synthetic owner remains available for scoped operator cleanup.
