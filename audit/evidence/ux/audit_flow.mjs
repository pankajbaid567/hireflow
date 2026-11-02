// Phase 6b: authenticated flow on the LOCAL stack. Signs up through the real UI, seeds synthetic jobs through the API,
// visits every route on desktop+mobile, records console/CSP/network errors, axe violations, contrast pairs, tab order, horizontal overflow.
import { createRequire } from 'node:module'; import { readFileSync, mkdirSync } from 'node:fs'; import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)); const req = createRequire(`${root}cloudflare/package.json`);
const { chromium } = req('playwright-core'); const BASE = 'http://127.0.0.1:4173'; const axeSrc = readFileSync(process.argv[2], 'utf8');
const shots = `${root}audit/evidence/ux/screens`; mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ executablePath: chromium.executablePath() });
const out = { steps: [], routes: [], contrast: {} };
const routes = ['/weekly-plan', '/applications', '/resumes', '/reports', '/hiring', '/profile'];
for (const vp of [{ w: 1366, h: 900, tag: 'desktop' }, { w: 390, h: 844, tag: 'mobile' }]) {
  const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } }); const page = await ctx.newPage();
  const bag = { csp: [], console: [], failed: [], pageErrors: [] };
  page.on('console', m => { if (['error', 'warning'].includes(m.type())) (/Content Security Policy|Refused to/.test(m.text()) ? bag.csp : bag.console).push(m.text().slice(0, 200)); });
  page.on('pageerror', e => bag.pageErrors.push(String(e).slice(0, 200)));
  page.on('response', r => { if (r.status() >= 400) bag.failed.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`); });
  await page.goto(BASE + '/profile'); await page.waitForLoadState('networkidle');
  const email = `ux-${vp.tag}-${Date.now()}@example.com`;
  await page.fill('input[name=name]', 'UX Tester'); await page.fill('input[name=email]', email); await page.fill('input[name=skills]', 'Python, SQL, React');
  await page.fill('input[name=target_roles]', 'Backend Intern'); await page.fill('input[name=weekly_quota]', '3');
  await page.getByRole('button', { name: /save profile/i }).click(); await page.waitForTimeout(1500);
  out.steps.push({ vp: vp.tag, afterSave: (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 300), url: page.url() });
  const me = await page.evaluate(async () => { const r = await fetch('/api/session'); return { status: r.status, text: (await r.text()).slice(0, 120) }; }); out.steps.push({ vp: vp.tag, session: me });
  const cookies = await ctx.cookies(); const uid = await page.evaluate(() => { try { return JSON.parse(localStorage.getItem('hireflow_profile') || 'null')?.id ?? Object.entries(localStorage).map(([k, v]) => k + '=' + v.slice(0, 60)); } catch { return null; } }); out.steps.push({ vp: vp.tag, uid, cookieNames: cookies.map(c => c.name) });
  for (const r of routes) {
    await page.goto(BASE + r); await page.waitForLoadState('networkidle'); await page.waitForTimeout(400);
    await page.evaluate(axeSrc);
    const axe = await page.evaluate(async () => { const x = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }); return x.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ').slice(0, 80), data: v.id === 'color-contrast' ? v.nodes.slice(0, 60).map(n => n.any[0]?.data && { fg: n.any[0].data.fgColor, bg: n.any[0].data.bgColor, ratio: n.any[0].data.contrastRatio, size: n.any[0].data.fontSize }) : undefined })); });
    const overflow = await page.evaluate(() => ({ scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth }));
    const h1 = await page.locator('h1').allInnerTexts(); const title = await page.title();
    // keyboard: tab 12 times, record focused element + whether it has a visible focus style
    const tabs = []; for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); tabs.push(await page.evaluate(() => { const e = document.activeElement; if (!e || e === document.body) return 'body'; const s = getComputedStyle(e); const vis = (s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0) || s.boxShadow !== 'none'; return `${e.tagName.toLowerCase()}:${(e.getAttribute('aria-label') || e.innerText || e.name || '').trim().slice(0, 28)}${vis ? '' : ' [NO-FOCUS-STYLE]'}`; })); }
    await page.screenshot({ path: `${shots}/${vp.tag}${r.replace(/\//g, '-')}.png`, fullPage: true });
    out.routes.push({ vp: vp.tag, route: r, title, h1, overflow, hOverflow: overflow.scrollW > overflow.clientW + 1, axe: axe.map(({ data, ...a }) => a), tabs, text: (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 160) });
    for (const a of axe) if (a.data) for (const d of a.data) if (d) { const k = `${d.fg} on ${d.bg}`; (out.contrast[k] ||= { ratio: d.ratio, size: d.size, count: 0 }).count++; }
  }
  out.steps.push({ vp: vp.tag, bag }); await ctx.close();
}
await browser.close(); console.log(JSON.stringify(out, null, 1));
