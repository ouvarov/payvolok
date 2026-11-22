import { describe, expect, it, vi } from 'vitest';

import { requestApi } from '@/api/client';

const answerWith = (response: Response) =>
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(() => Promise.resolve(response)),
  );

describe('requestApi', () => {
  it('returns the status and parsed body of a JSON answer', async () => {
    answerWith(
      new Response('{"code":"rate_limited"}', {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(requestApi('/api/demo/payments')).resolves.toEqual({
      kind: 'response',
      status: 429,
      body: { code: 'rate_limited' },
    });
  });

  it('treats a gateway error with a JSON body as unreachable', async () => {
    answerWith(
      new Response('{"error":"bad gateway"}', {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(requestApi('/api/health')).resolves.toEqual({
      kind: 'unreachable',
    });
  });

  it('treats an answer that is not JSON as unreachable', async () => {
    answerWith(
      new Response('<html></html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await expect(requestApi('/api/health')).resolves.toEqual({
      kind: 'unreachable',
    });
  });

  it('treats a failed request as unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(() =>
        Promise.reject(new TypeError('Failed to fetch')),
      ),
    );

    await expect(requestApi('/api/health')).resolves.toEqual({
      kind: 'unreachable',
    });
  });
});
