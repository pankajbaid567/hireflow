import { describe, expect, it, vi } from 'vitest';
import { artifactUrl, errorMessage, externalUrl } from '../api/client';
describe('API response helpers', () => {
  it('routes relative artifacts through the API and preserves absolute URLs', () => {
    expect(artifactUrl('/resumes/1/2/download')).toBe('/api/resumes/1/2/download');
    expect(artifactUrl('/api/resumes/1/2/download')).toBe('/api/resumes/1/2/download');
    expect(artifactUrl('https://storage.example.com/resume.pdf')).toBe('https://storage.example.com/resume.pdf');
  });
  it('rejects executable and protocol-relative resource URLs', () => {
    expect(externalUrl('javascript:alert(1)')).toBeNull(); expect(artifactUrl('//evil.example/asset')).toBeNull(); expect(artifactUrl('data:text/html,hello')).toBeNull();
  });
  it('formats validation, network, and timeout failures without crashing', () => {
    expect(errorMessage({ response: { data: { detail: [{ loc: ['body', 'email'], msg: 'Invalid email' }] } } })).toBe('email: Invalid email');
    expect(errorMessage({ request: {} })).toMatch('Cannot reach HireFlow');
    expect(errorMessage({ code: 'ECONNABORTED' })).toMatch('took too long');
  });
});

it('sends cross-origin cookies only for Cloudflare deployments', async () => {
  const { default: original } = await import('../api/client');
  expect(original.defaults.withCredentials).toBe(false);
  vi.stubEnv('VITE_DEPLOYMENT_TARGET', 'cloudflare');
  vi.resetModules();
  const { default: cloud } = await import('../api/client');
  expect(cloud.defaults.withCredentials).toBe(true);
});
