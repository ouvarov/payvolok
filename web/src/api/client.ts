type ApiResult =
  { kind: 'response'; status: number; body: unknown } | { kind: 'unreachable' };

const GATEWAY_STATUSES = new Set([502, 504]);

const UNREACHABLE: ApiResult = { kind: 'unreachable' };

const isJsonResponse = (response: Response): boolean =>
  response.headers.get('content-type')?.includes('application/json') ?? false;

const requestApi = async (
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> => {
  try {
    const response = await fetch(path, init);
    if (GATEWAY_STATUSES.has(response.status) || !isJsonResponse(response))
      return UNREACHABLE;

    const body: unknown = await response.json();
    return { kind: 'response', status: response.status, body };
  } catch {
    return UNREACHABLE;
  }
};

export type { ApiResult };
export { requestApi };
