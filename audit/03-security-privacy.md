# Phase 3 — Security & privacy audit

Method: (1) dynamic probes against a **local** Worker in Miniflare with a local D1 and a *stubbed* outbound network (zero real egress; 0 outbound requests were made) — `evidence/security/probe_worker.mjs`, results in `probe-results.json` (synthetic users only, session token redacted); (2) targeted static review of auth/email/webhook/URL code; (3) `npm audit` and `pip-audit` (read-only registry queries). Production was not probed. Labels: **confirmed** (reproduced) · **static** (read, not exploited) · **unknown**.

## 1. Threat model
| Asset | Why it matters |
|---|---|
| Resumes/PDF versions, profile PII (name, email, phone, links) | private personal data, stored in D1 + private KV |
| Session cookie, passkeys, recovery keys | account takeover |
| `ACCESS_CODE` (single secret) | signup bootstrap + login-as-any-user + checkpoint encryption key |
| Approval binding (exact resume version + answers) | prevents wrongful submissions |
| Provider keys, Gmail app password, D1/KV/Queue quotas | cost and abuse |

| Actor | Capability assumed |
|---|---|
| Anonymous internet user | can call public routes, sign up (rate-limited), submit URLs |
| Second tenant (malicious user) | valid session; tries other users' IDs |
| Hostile content author | controls JD text/pages/PDFs that the system ingests |
| Compromised dependency / CI | supply chain |
| Operator error | misconfig (CSP, secrets, deploy drift) |

Trust boundaries: Browser→Pages proxy (injects bootstrap code) → Worker; Worker→providers (Gemini/Groq/search/Gmail); Worker→public job sites (untrusted content); Browser Run→employer-like forms (owned QA form only).

## 2. Results
| Area | Result |
|---|---|
| **Tenant isolation (IDOR)** | 39 route/method probes with user B's cookie against user A's resources: **0 cross-tenant reads or writes, 0 data leaks** (confirmed). Every one returns 404 (non-enumerating). Anonymous: 401 on all private routes. `/account/schedule` and `/account/security` return 200 to B because they are session-scoped (B's own data). **Inconclusive** (the resource did not exist for the owner either): resume download, prep-export HTML, email-delivery status, hiring shortlist/report, backups, discover-by-uuid. These need seeded state; scheduled for Phase 5 E2E. |
| **Existence oracle** | B gets `Resource not found` for A's real application vs `Application not found` for a missing one → distinguishable (F-030, S3). |
| **Cookies** | `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=30d`; token 64-hex, stored hashed. Good. |
| **CSRF/Origin** | disallowed Origin → 403 on GET and on mutating requests. Missing Origin accepted (non-browser clients); browsers always send Origin on cross-origin POST, so residual risk is low (F-029). |
| **Signup abuse** | no code → 401; 5 signups per IP per 10 min then 429 (confirmed 201×5, 429×2). |
| **Login brute force** | 10 wrong tries per IP then 429. Per-IP only (F-036). |
| **Shared secret (W-004)** | holder of `ACCESS_CODE` can log in as **any** user by email (confirmed 200 + cookie). It is also the signup bootstrap held by the Pages proxy and the checkpoint-key source: one secret, three roles (F-022 upgraded to confirmed). |
| **Session transfer (Vercel bridge)** | token in URL fragment; first consume 200, replay 401, wrong Origin 403, bogus token 401. Good. |
| **Logout** | old cookie → 401. Good. |
| **SSRF (listing URL)** | 16 of 19 hostile URLs rejected (422): loopback, link-local/metadata, IPv6 loopback and v4-mapped, decimal/hex/octal IPs, `.internal`, embedded credentials, `file:`/`ftp:`/`javascript:`. **Accepted: `example.com:22`, `example.com:6379`, `127.0.0.1.nip.io`** (F-031). Redirects (static): every untrusted-URL fetch uses `redirect:'manual'` and revalidates each hop (automation.ts, source_reader.ts, reviews.ts, dynamic_source.ts); remaining `boundedFetch` calls hit fixed provider hosts. Workers cannot resolve DNS before fetching, so rebinding can't be pre-checked; platform egress is not expected to reach private ranges (inference) → impact **low**, defence-in-depth only. |
| **Input handling** | malformed JSON / null / array → 422; 300 KB JSON → 413; bad mode / negative quota → 422; SQL-like strings stored verbatim with tables intact (parameterised); path-like IDs → 404; Devanagari, emoji and RTL-override name accepted. |
| **PDF upload** | 0-byte, text-as-pdf, HTML-as-pdf → 400; 3.3 MB → 413; header-only `%PDF-1.7` → **201 with an explicit "automatic resume reading is unavailable" warning** (not a silent empty profile; F-034, S4: magic-byte check only). Page-count bombs, password-protected and polyglot PDFs **not probed** (need the extractor; Phase 4). |
| **Output encoding / XSS** | hostile name/title/company/description (`<img onerror>`, `<script>`) in the weekly report HTML: **escaped**, no raw tags; response CSP `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'` plus `nosniff`. All HTML builders use an escape helper (static). React has no `dangerouslySetInnerHTML` (frontend lane). |
| **API headers** | `cache-control: no-store`, `nosniff`, CORS pinned to the allowed origin with credentials. |
| **Passkeys (static)** | origin and rpID pinned from `PUBLIC_BASE_URL`/config, not the request; challenge single-use (`DELETE … RETURNING`) and bound to browser hash + session; `userVerification: required`; counter compare-and-swap (replay-resistant). Not exercised with a real authenticator. |
| **Recovery keys (static)** | 8 keys, 256-bit random, stored hashed, regenerated atomically, rate-limited, generic invalid message. |
| **Email (static)** | strict mailbox regex (no CRLF), subject control-char rejection, fixed From, recipient set = sender + ≤10 configured, PDF-magic attachment check, nodemailer file/URL access disabled, no automatic resend after an uncertain outcome. Webhooks: HMAC via `crypto.subtle.verify`, 5-min timestamp window, 128 KB body cap. |
| **Unconfigured email** | `POST /report/{id}/latest/email` → 503 with an explicit "configure provider" message: honest, not a false success (confirmed). |
| **Supply chain** | `pip-audit`: 0 known vulnerabilities across 61 dependencies. `npm audit`: cloudflare 3 (1 high `undici` via `miniflare`; 2 moderate incl. `wrangler`), frontend 1 high (`follow-redirects` via `axios`). These are dev-tooling / Node-adapter paths not in the deployed Worker or browser bundle (inference from dependency chains), fixable by bumps (F-032). CI has no `permissions:`, tag-pinned actions, no Dependabot/CodeQL (F-004). |
| **Privacy / lifecycle (static)** | deletion relies on FK cascades (22 of 24 user-bearing tables cascade; `shortlists` deleted explicitly; `hiring_email_deliveries` cascades via shortlist). No test deletes a workspace populated with hiring rows (F-035). `docs/evidence/*` has no emails or secret-shaped values (Phase 0). |
| **Security headers (Pages)** | none of CSP / HSTS / frame-ancestors; no `_headers` file (F-006, F-017). |
| **Not yet done** | prompt-injection corpus (Phase 4), authenticated LLM-route rate limits (W-005, static only), real-authenticator passkey flow, production header scan beyond one HEAD request, page-count-bomb PDFs. No CSV export exists, so CSV injection does not apply to output. |

## 3. OWASP Top 10 (2021) / ASVS mapping
| Item | Status |
|---|---|
| A01 Broken Access Control / V4 | **Pass** on 39 probes; gaps: inconclusive set above, existence oracle (F-030). |
| A02 Cryptographic Failures / V6, V9 | Pass: hashed session and recovery tokens, HMAC webhooks, TLS. One shared secret also derives the checkpoint key (F-022). |
| A03 Injection / V5 | Pass: parameterised SQL, output escaping, no header injection. Prompt injection: Phase 4. |
| A04 Insecure Design | Strong approval binding; weak: `ACCESS_CODE` role overload. |
| A05 Misconfiguration / V14 | **Fail (S2)**: no CSP / HSTS / frame-ancestors on Pages (F-006). Public `/docs` listing (W-013, S4). |
| A06 Vulnerable Components / V14.2 | Dev-only advisories (F-032). |
| A07 Identification & Auth Failures / V2, V3 | Pass: rate limits, passkeys + recovery; per-IP-only throttle (F-036). |
| A08 Software & Data Integrity | CI lacks pinning (F-004). |
| A09 Logging & Monitoring / V7 | Weak: unhandled errors lack a correlation id (F-020). |
| A10 SSRF / V12.6 | Pass with a defence-in-depth gap (F-031). |

## 4. Reproduce
`export PATH=$HOME/.nvm/versions/node/v22.23.4/bin:$PATH; node audit/evidence/security/probe_worker.mjs > audit/evidence/security/probe-results.json` (Node ≥22.12; no network egress; synthetic data only).
