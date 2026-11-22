import { describe, expect, it, vi } from 'vitest';

import { checkHealth, classifyWakeResponse } from '@/api/wake';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

const html = (status: number) =>
  new Response('<!doctype html><title>Waking up</title>', {
    status,
    headers: { 'Content-Type': 'text/html' },
  });

const abortError = () => new DOMException('Aborted', 'AbortError');

const answerHealthWith = (answer: () => Promise<Response>) => {
  const fetchMock = vi.fn<typeof fetch>(answer);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('checkHealth', () => {
  it.each([
    ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['an aborted attempt', () => Promise.reject(abortError())],
    ['502', () => Promise.resolve(html(502))],
    ['503', () => Promise.resolve(json(503, { status: 'unavailable' }))],
    ['504', () => Promise.resolve(html(504))],
    ['200 text/html', () => Promise.resolve(html(200))],
    ['200 {}', () => Promise.resolve(json(200, {}))],
    [
      '200 with a broken JSON body',
      () =>
        Promise.resolve(
          new Response('{"status":', {
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    ],
  ])('treats %s as asleep', async (_case, answer) => {
    answerHealthWith(answer);

    await expect(checkHealth(new AbortController().signal)).resolves.toBe(
      'asleep',
    );
  });

  it('is ready on 200 {status: "ok"}', async () => {
    answerHealthWith(() => Promise.resolve(json(200, { status: 'ok' })));

    await expect(checkHealth(new AbortController().signal)).resolves.toBe(
      'ready',
    );
  });

  it('reports 500 as an error', async () => {
    answerHealthWith(() =>
      Promise.resolve(json(500, { statusCode: 500, code: 'internal_error' })),
    );

    await expect(checkHealth(new AbortController().signal)).resolves.toBe(
      'error',
    );
  });

  it('asks the same-origin health path with the given signal', async () => {
    const fetchMock = answerHealthWith(() =>
      Promise.resolve(json(200, { status: 'ok' })),
    );
    const { signal } = new AbortController();

    await checkHealth(signal);

    expect(fetchMock).toHaveBeenCalledWith('/api/health', { signal });
  });
});

describe('classifyWakeResponse', () => {
  it('treats a JSON 503 from the API as asleep, not as an error', () => {
    expect(
      classifyWakeResponse({
        kind: 'response',
        status: 503,
        body: { status: 'unavailable' },
      }),
    ).toBe('asleep');
  });

  it('treats an unexpected client error as an error', () => {
    expect(
      classifyWakeResponse({ kind: 'response', status: 404, body: {} }),
    ).toBe('error');
  });
});
