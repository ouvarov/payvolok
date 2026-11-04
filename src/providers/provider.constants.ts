const PROVIDER_CODES = ['fake'] as const;

type ProviderCode = (typeof PROVIDER_CODES)[number];

const isProviderCode = (code: string): code is ProviderCode =>
  (PROVIDER_CODES as readonly string[]).includes(code);

export { isProviderCode, PROVIDER_CODES };
export type { ProviderCode };
