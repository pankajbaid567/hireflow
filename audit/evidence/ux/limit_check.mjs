import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url)); const { chromium } = createRequire(`${root}cloudflare/package.json`)('playwright-core');
const b = await chromium.launch({ executablePath: chromium.executablePath() }); const page = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
await page.goto('http://127.0.0.1:4173/profile'); await page.fill('input[name=name]', 'Limit'); await page.fill('input[name=email]', 'limit@example.com'); await page.getByRole('button', { name: /save profile/i }).click(); await page.waitForTimeout(1500);
const alerts = await page.locator('[role=alert],[role=status],.error,.notice,.toast').allInnerTexts(); console.log(JSON.stringify({ alerts, body: (await page.innerText('main')).replace(/\s+/g, ' ').slice(0, 300) })); await b.close();
