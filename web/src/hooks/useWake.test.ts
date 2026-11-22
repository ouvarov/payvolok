import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWake } from '@/hooks/useWake';
import { fakeHealth } from '@/test/healthFakes';

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const signalOfCall = (fetchMock: ReturnType<typeof fakeHealth>, call: number) =>
  fetchMock.mock.calls[call]?.[1]?.signal;

const countInFlight = () => {
  const counter = { current: 0, max: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          counter.current += 1;
          counter.max = Math.max(counter.max, counter.current);
          init?.signal?.addEventListener('abort', () => {
            counter.current -= 1;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        }),
    ),
  );
  return counter;
};

describe('useWake', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a hung attempt at 20 s and starts the next one 2 s after it ends', async () => {
    const fetchMock = fakeHealth('hang');
    renderHook(() => useWake());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await advance(19_999);
    expect(signalOfCall(fetchMock, 0)?.aborted).toBe(false);

    await advance(1);
    expect(signalOfCall(fetchMock, 0)?.aborted).toBe(true);
    await advance(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never has two attempts in flight while the server hangs', async () => {
    const counter = countInFlight();
    renderHook(() => useWake());

    await advance(89_000);

    expect(counter.max).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('waits 2 s after each quick asleep answer', async () => {
    const fetchMock = fakeHealth('asleep');
    renderHook(() => useWake());

    await advance(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays quiet for 3 s, then reports waking with the elapsed seconds', async () => {
    fakeHealth('asleep');
    const { result } = renderHook(() => useWake());

    await advance(2_999);
    expect(result.current.phase).toBe('checking');

    await advance(1);
    expect(result.current).toMatchObject({
      phase: 'waking',
      elapsedSeconds: 3,
    });
  });

  it('gives up at 90 s and starts over on retry', async () => {
    const fetchMock = fakeHealth('asleep');
    const { result } = renderHook(() => useWake());

    await advance(89_999);
    expect(result.current.phase).toBe('waking');

    await advance(1);
    expect(result.current.phase).toBe('slow');
    const callsWhenSlow = fetchMock.mock.calls.length;

    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(callsWhenSlow);

    act(() => result.current.retry());
    expect(result.current).toMatchObject({
      phase: 'waking',
      elapsedSeconds: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(callsWhenSlow + 1);
  });

  it('is ready once the health check answers ok and stops checking', async () => {
    const fetchMock = fakeHealth('asleep', 'ready');
    const { result } = renderHook(() => useWake());

    await advance(2_000);
    expect(result.current.phase).toBe('ready');

    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops on an error answer', async () => {
    const fetchMock = fakeHealth('error');
    const { result } = renderHook(() => useWake());

    await advance(10_000);

    expect(result.current.phase).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts the attempt in flight on unmount', async () => {
    const fetchMock = fakeHealth('hang');
    const { unmount } = renderHook(() => useWake());

    unmount();
    await advance(30_000);

    expect(signalOfCall(fetchMock, 0)?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
