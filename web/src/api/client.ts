type ApiResult =
  { kind: 'response'; status: number; body: unknown } | { kind: 'unreachable' };

const GATEWAY_STATUSES = new Set([502, 504]);

const UNREACHABLE: ApiResult = { kind: 'unreachable' };

const isJsonResponse = (response: Response): boolean =>
  response.headers.get('content-type')?.includes('application/json') ?? false;

const readJsonBody = async (response: Response): Promise<unknown> => {
  if (!isJsonResponse(response)) return undefined;
  try {
    const body: unknown = await response.json();
    return body;
  } catch {
    return undefined;
  }
};

const requestApi = async (
  path: string,
  init: RequestInit = {},
): Promise<ApiResult> => {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    return UNREACHABLE;
  }
  if (GATEWAY_STATUSES.has(response.status)) return UNREACHABLE;

  return {
    kind: 'response',
    status: response.status,
    body: await readJsonBody(response),
  };
};

export type { ApiResult };
export { requestApi };
