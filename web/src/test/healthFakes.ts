import { vi } from 'vitest';

type HealthAnswer = 'ready' | 'asleep' | 'error' | 'hang';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const hangUntilAborted = (signal?: AbortSignal | null) =>
  new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')),
    );
  });

const answer = (kind: HealthAnswer, signal?: AbortSignal | null) => {
  if (kind === 'hang') return hangUntilAborted(signal);
  if (kind === 'ready')
    return Promise.resolve(jsonResponse(200, { status: 'ok' }));
  if (kind === 'error')
    return Promise.resolve(jsonResponse(500, { code: 'internal_error' }));
  return Promise.resolve(jsonResponse(503, { status: 'unavailable' }));
};

const fakeHealth = (...answers: HealthAnswer[]) => {
  let callCount = 0;
  const fetchMock = vi.fn<typeof fetch>((_input, init) => {
    const kind = answers[Math.min(callCount, answers.length - 1)] ?? 'asleep';
    callCount += 1;
    return answer(kind, init?.signal);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

export type { HealthAnswer };
export { fakeHealth };
