# HireFlow Cloudflare runtime

The TypeScript Worker provides private profile/application APIs, D1 records, KV files, queued Browser Run automation, resume PDFs, preparation guides, and reports. The React dashboard's hosting target is **Cloudflare Pages**, with a same-origin `/api` Function and `API` service binding to the Worker.

**Live dashboard:** [hireflow-dashboard.pages.dev](https://hireflow-dashboard.pages.dev/profile), Pages `325fde6a`. **Live API:** [hireflow-api.baidpankaj567.workers.dev](https://hireflow-api.baidpankaj567.workers.dev/health), Worker version prefix `a2e2257c`. D1 migrations through `0003` are applied. Public profile/deep-link, API-health, anonymous-session and protected-resource checks passed. On 22 October 2026, production search verified and imported six active opportunities in 7.457 seconds, without submitting an application. Complete controlled UI submission, current tailoring-provider provenance and authenticated session migration are separate verification gates. The former Vercel origin is a deployed temporary migration bridge; signed-out old bookmarks redirect to Pages. Normal users enter no operator access code.

Read [deployment and resource details](../docs/cloudflare.md) and the [milestone audit](../docs/milestone-audit.md). The Worker uses lexical matching. Resume preparation uses Groq to select validated existing facts/projects, then renders a role-specific summary and preserves the selected evidence; deterministic selection remains the explicit fallback. Per-version metadata records the method/model and selected facts. This is separate from Python FAISS and does not allow invented qualifications. Production email still needs a verified sender/provider configuration.

Use Node 22+:

```bash
npm ci
cp .dev.vars.example .dev.vars
# Configure ignored local credentials; never commit them.
npm run db:local
npm run dev
```

Checks without publishing:

```bash
npm run check
```

API deployment uses `cloudflare/wrangler.jsonc`; Pages deployment runs from `frontend` with its separate configuration. Run `npm run db:remote` before a production update to apply all pending migrations, including `0003`'s resume-preparation leases and tailoring metadata. Existing D1/KV/queue/Pages resources are already provisioned. Resource creation, remote migrations, secret rotation and publication change the account; the guide documents their exact targets. R2 is optional and was not activated on this account.
