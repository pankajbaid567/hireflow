import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRemote } from '../hooks/useRemote';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

describe('useRemote (audit F-023)', () => {
  it('keeps the data on screen while a manual reload is in flight', async () => {
    const calls = [deferred(), deferred()];
    let n = 0;
    const { result } = renderHook(() => useRemote(() => calls[n++].promise, []));
    expect(result.current.loading).toBe(true);
    await act(async () => { calls[0].resolve({ plan: 1 }); });
    await waitFor(() => expect(result.current.data).toEqual({ plan: 1 }));
    act(() => result.current.reload());
    // Previously `data` was reset to null here, blanking the page on every poll.
    expect(result.current.data).toEqual({ plan: 1 });
    expect(result.current.refreshing).toBe(true);
    await act(async () => { calls[1].resolve({ plan: 2 }); });
    await waitFor(() => expect(result.current.data).toEqual({ plan: 2 }));
    expect(result.current.refreshing).toBe(false);
  });
  it('clears the data when the dependencies change (a different resource)', async () => {
    const { result, rerender } = renderHook(({ id }) => useRemote(async () => ({ id }), [id]), { initialProps: { id: 1 } });
    await waitFor(() => expect(result.current.data).toEqual({ id: 1 }));
    rerender({ id: 2 });
    expect(result.current.data).toBeNull();
    await waitFor(() => expect(result.current.data).toEqual({ id: 2 }));
  });
  it('ignores a slow response that arrives after a newer request finished', async () => {
    const slow = deferred(), fast = deferred(); const order = [slow, fast]; let n = 0;
    const { result } = renderHook(() => useRemote(() => order[n++].promise, []));
    act(() => result.current.reload());
    await act(async () => { fast.resolve('new'); });
    await waitFor(() => expect(result.current.data).toBe('new'));
    await act(async () => { slow.resolve('stale'); });
    expect(result.current.data).toBe('new');
  });
  it('surfaces an error without losing the retry handle', async () => {
    const { result } = renderHook(() => useRemote(async () => { throw new Error('boom'); }, []));
    await waitFor(() => expect(result.current.error).not.toBe(''));
    expect(typeof result.current.reload).toBe('function');
  });
});
