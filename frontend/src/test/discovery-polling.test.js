import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import client, { api, errorMessage } from '../api/client';

const id = 'b2980856-2570-46eb-aa40-3d2ea00348e9';
const path = `/jobs/7/discover/${id}`;
const queued = { discovery_id: id, state: 'queued', poll_url: path };
let post, get;
beforeEach(() => { vi.useFakeTimers(); post = vi.spyOn(client, 'post'); get = vi.spyOn(client, 'get'); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); });

describe('durable opportunity discovery polling', () => {
  it('keeps synchronous completed results compatible and performs no poll', async () => {
    const result = { imported: 2, discovered: 3, sources: [{ name: 'Naukri', verified: 2 }], warnings: ['One source was restricted.'] };
    post.mockResolvedValue({ status: 200, data: result });
    expect(await api.discoverJobs(7)).toBe(result);
    expect(get).not.toHaveBeenCalled(); expect(post).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it('posts once and waits through queued/running until the final result, preserving source diagnostics', async () => {
    post.mockResolvedValue({ status: 202, data: queued });
    const result = { discovery_id: id, state: 'completed', imported: 4, discovered: 6, sources: [{ name: 'LinkedIn', verified: 0, status: 'restricted' }, { name: 'Lever', verified: 2, status: 'ok' }], warnings: ['Partial source access.'] };
    get.mockResolvedValueOnce({ status: 200, data: { discovery_id: id, state: 'running' } }).mockResolvedValueOnce({ status: 200, data: result });
    let settled = false; const pending = api.discoverJobs('7'); pending.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1500);
    expect(settled).toBe(false); expect(get).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe(result); expect(post).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, path, expect.objectContaining({ timeout: 15000, signal: expect.any(AbortSignal) }));
    expect(client.defaults.withCredentials).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('surfaces a failed job as a safe Error while retaining current source rows for the UI', async () => {
    const sources = [{ name: 'Naukri', verified: 0, status: 'unavailable' }];
    post.mockResolvedValue({ status: 202, data: queued });
    get.mockResolvedValue({ status: 200, data: { discovery_id: id, state: 'failed', detail: 'Search provider is temporarily unavailable.', sources, warnings: ['Try again later.'] } });
    const pending = api.discoverJobs(7); const checked = expect(pending).rejects.toMatchObject({ message: 'Search provider is temporarily unavailable.', response: { data: { sources } } });
    await vi.advanceTimersByTimeAsync(1500); await checked;
    expect(post).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['https://evil.example/discover', '//evil.example/discover', `/jobs/8/discover/${id}`, '/account/security'])('rejects an unsafe or another-owner poll URL before sending credentials: %s', async poll_url => {
    post.mockResolvedValue({ status: 202, data: { ...queued, poll_url } });
    await expect(api.discoverJobs(7)).rejects.toThrow('search response could not be read');
    expect(get).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects a changed search generation rather than showing an unrelated result', async () => {
    post.mockResolvedValue({ status: 202, data: queued });
    get.mockResolvedValue({ status: 200, data: { ...queued, discovery_id: '32c595ed-ff0c-43bf-b811-18b17a42bc38', state: 'completed', imported: 9 } });
    const pending = api.discoverJobs(7), checked = expect(pending).rejects.toThrow('search response could not be read');
    await vi.advanceTimersByTimeAsync(1500); await checked; expect(get).toHaveBeenCalledTimes(1);
  });
  it('bounds the whole operation even if an HTTP request never settles, without launching a replacement search', async () => {
    post.mockResolvedValue({ status: 202, data: queued }); get.mockReturnValue(new Promise(() => {}));
    const pending = api.discoverJobs(7), checked = expect(pending).rejects.toThrow('Opportunity search took too long');
    await vi.advanceTimersByTimeAsync(180000); await checked;
    expect(post).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels an outstanding poll when the caller aborts and releases timers', async () => {
    post.mockResolvedValue({ status: 202, data: queued }); get.mockReturnValue(new Promise(() => {}));
    const controller = new AbortController(), pending = api.discoverJobs(7, { signal: controller.signal }), checked = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Stopped waiting for opportunity search.' });
    await vi.advanceTimersByTimeAsync(1500); controller.abort(); await checked;
    expect(get.mock.calls[0][1].signal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not launch a search for an invalid owner or already aborted caller', async () => {
    await expect(api.discoverJobs(undefined)).rejects.toThrow('Open your profile');
    const controller = new AbortController(); controller.abort();
    await expect(api.discoverJobs(7, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(post).not.toHaveBeenCalled();
  });
  it('retains private-session HTTP errors without retrying the original POST', async () => {
    post.mockResolvedValue({ status: 202, data: queued });
    const error = { response: { status: 401, data: { detail: 'Recover your workspace before continuing.' } } }; get.mockRejectedValue(error);
    const pending = api.discoverJobs(7), checked = expect(pending).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(1500); await checked;
    expect(errorMessage(error)).toBe('Recover your workspace before continuing.'); expect(post).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
  });
});
