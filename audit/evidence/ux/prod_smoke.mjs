// Read-only production smoke: load pages, record CSP/console errors, run axe. Creates no accounts.
import { createRequire } from 'node:module'; import { readFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)); const { chromium } = createRequire(`${root}cloudflare/package.json`)('playwright-core'); const axeSrc = readFileSync(process.argv[2], 'utf8');
const b = await chromium.launch({ executablePath: chromium.executablePath() }); const out = [];
for (const [tag, w, h] of [['desktop', 1366, 900], ['mobile', 390, 844]]) { const page = await (await b.newContext({ viewport: { width: w, height: h } })).newPage(); const csp = [], errs = [];
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) (/Content Security|Refused/.test(m.text()) ? csp : errs).push(m.text().slice(0, 160)); }); page.on('pageerror', e => errs.push(String(e).slice(0, 160)));
  for (const r of ['/profile', '/weekly-plan', '/applications', '/reports']) { await page.goto('https://hireflow-dashboard.pages.dev' + r); await page.waitForLoadState('networkidle'); await page.evaluate(axeSrc); const v = await page.evaluate(async () => (await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] })).violations.map(x => `${x.id}:${x.nodes.length}`)); out.push({ tag, r, title: await page.title(), axe: v, csp: [...csp], errs: [...errs] }); } }
await b.close(); console.log(JSON.stringify(out, null, 1));
