import { describe, expect, it } from 'vitest';
import { routeTitle } from '../App';

describe('route titles (audit F-024)', () => {
  it('gives every primary route a distinct title', () => {
    const routes = ['/weekly-plan', '/applications', '/resumes', '/reports', '/hiring', '/profile', '/applications/12/prep-guide'];
    const titles = routes.map(routeTitle);
    expect(new Set(titles).size).toBe(routes.length);
    expect(titles.every((t) => t.endsWith('HireFlow'))).toBe(true);
  });
  it('falls back to the product name for unknown paths', () => { expect(routeTitle('/nope')).toBe('HireFlow'); });
});
