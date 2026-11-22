import type { ApiResult } from '@/api/client';
import { requestApi } from '@/api/client';

type WakeCheck = 'ready' | 'asleep' | 'error';

const HEALTH_PATH = '/api/health';

const SLEEPING_STATUSES = new Set([502, 503, 504]);

const hasOkStatus = (body: unknown): boolean =>
  typeof body === 'object' &&
  body !== null &&
  'status' in body &&
  body.status === 'ok';

const classifyWakeResponse = (result: ApiResult): WakeCheck => {
  if (result.kind === 'unreachable') return 'asleep';
  if (result.status === 200)
    return hasOkStatus(result.body) ? 'ready' : 'asleep';
  if (SLEEPING_STATUSES.has(result.status)) return 'asleep';
  return 'error';
};

const checkHealth = async (signal: AbortSignal): Promise<WakeCheck> =>
  classifyWakeResponse(await requestApi(HEALTH_PATH, { signal }));

export type { WakeCheck };
export { checkHealth, classifyWakeResponse };
