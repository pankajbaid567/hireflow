import { createRequire } from 'node:module';
const { chromium } = createRequire('/Users/pankajbaid/pankajbaid567/hireflow/hireflow-ai_3/cloudflare/package.json')('playwright-core');
const b = await chromium.launch({ executablePath: chromium.executablePath() }); const page = await (await b.newContext({ viewport: { width: 390, height: 700 } })).newPage();
await page.goto('http://127.0.0.1:4173/weekly-plan'); await page.waitForTimeout(1200); await page.screenshot({ path: '/Users/pankajbaid/pankajbaid567/hireflow/hireflow-ai_3/audit/evidence/ux/screens/mobile-empty-after.png' }); await b.close();
