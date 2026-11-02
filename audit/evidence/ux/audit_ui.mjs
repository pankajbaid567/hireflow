// Phase 6 browser audit against the LOCAL stack (serve.mjs). Synthetic data only.
//   node audit/evidence/ux/audit_ui.mjs <axe.min.js path> > audit/evidence/ux/ui-results.json
import { createRequire } from 'node:module'; import { readFileSync, mkdirSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)); const req = createRequire(`${root}cloudflare/package.json`);
const { chromium } = req('playwright-core'); const BASE = 'http://127.0.0.1:4173'; const axeSrc = readFileSync(process.argv[2], 'utf8');
const shots = `${root}audit/evidence/ux/screens`; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chromium.executablePath() });
const out = { base: BASE, note: 'local stack, synthetic data, outbound stubbed', pages: [] };
async function scan(page, name, viewport) {
  const rec = { name, viewport, console: [], csp: [], failed: [], pageErrors: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) { const t = m.text(); (/Content Security Policy|Refused to/.test(t) ? rec.csp : rec.console).push(t.slice(0, 220)); } });
  page.on('pageerror', e => rec.pageErrors.push(String(e).slice(0, 200)));
  page.on('requestfailed', r => rec.failed.push(`${r.method()} ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', r => { if (r.status() >= 400 && !/\/api\/(profile\/\d+|session)/.test(r.url()) ) rec.failed.push(`${r.status()} ${r.url()}`); });
  return rec;
}
async function axe(page) {
  await page.evaluate(axeSrc);
  return page.evaluate(async () => { const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }); return r.violations.map(v => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 100) })); });
}
const routes = ['/', '/weekly-plan', '/applications', '/resumes', '/reports', '/hiring', '/profile'];
for (const vp of [{ w: 1366, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } }); const page = await ctx.newPage();
  const first = await scan(page, `first-visit ${vp.tag}`, vp.tag); await page.goto(BASE + '/'); await page.waitForLoadState('networkidle');
  first.title = await page.title(); first.axe = await axe(page); first.text = (await page.innerText('body')).slice(0, 400); await page.screenshot({ path: `${shots}/first-${vp.tag}.png`, fullPage: true }); out.pages.push(first);
  // sign up through the real UI if a form is present
  const signup = await page.locator('input').count();
  first.inputs = signup;
  const names = await page.locator('input').evaluateAll(els => els.map(e => ({ name: e.name, type: e.type, label: e.labels?.[0]?.innerText || e.getAttribute('aria-label') || '' })));
  first.inputList = names.slice(0, 12);
  await ctx.close();
}
await browser.close(); console.log(JSON.stringify(out, null, 1));
