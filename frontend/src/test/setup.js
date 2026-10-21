import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node's optional native Web Storage can shadow the jsdom implementation.
// Exercise browser storage consistently on every supported Node version.
const storage = new Map();
vi.stubGlobal('localStorage', {
  getItem: key => storage.get(String(key)) ?? null,
  setItem: (key, value) => storage.set(String(key), String(value)),
  removeItem: key => storage.delete(String(key)),
  clear: () => storage.clear(),
  key: index => [...storage.keys()][index] ?? null,
  get length() { return storage.size; },
});
afterEach(() => { cleanup(); localStorage.clear(); });
