import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Audit F-006/F-017: the Pages site must ship CSP, HSTS and clickjacking protection.
const text = readFileSync(`${process.cwd()}/public/_headers`, 'utf8');
const block = (path) => {
  const start = text.split('\n').findIndex((line) => line.trim() === path);
  expect(start, `no rule for ${path}`).toBeGreaterThanOrEqual(0);
  const out = [];
  for (const line of text.split('\n').slice(start + 1)) { if (/^\S/.test(line)) break; if (line.trim()) out.push(line.trim()); }
  return out;
};

describe('Cloudflare Pages security headers', () => {
  const all = block('/*');
  const get = (name) => all.find((line) => line.toLowerCase().startsWith(`${name.toLowerCase()}:`)) || '';
  it('sends HSTS, nosniff, referrer and framing protection on every page', () => {
    expect(get('Strict-Transport-Security')).toMatch(/max-age=\d{7,}/);
    expect(get('X-Content-Type-Options')).toMatch(/nosniff/);
    expect(get('X-Frame-Options')).toMatch(/DENY/);
    expect(get('Referrer-Policy')).toMatch(/strict-origin/);
  });
  it('ships a CSP without unsafe-eval or wildcard sources', () => {
    const csp = get('Content-Security-Policy');
    expect(csp).toMatch(/default-src 'self'/);
    expect(csp).toMatch(/script-src 'self'(?!.*unsafe)/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).not.toMatch(/unsafe-eval|\*\s|https:\s*;/);
  });
  it('detaches the CSP only for the owned synthetic QA fixtures', () => {
    expect(block('/careers/*')).toContain('! Content-Security-Policy');
    expect(block('/assets/hireflow-qa-form.html')).toContain('! Content-Security-Policy');
  });
});
