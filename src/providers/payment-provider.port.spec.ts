import { ProviderError } from './payment-provider.port';

describe('ProviderError', () => {
  it.each([
    ['unavailable', true],
    ['rejected', false],
    ['misconfigured', false],
  ] as const)('with kind %s has isRetryable %s', (kind, isRetryable) => {
    const error = new ProviderError('test', { providerCode: 'fake', kind });

    expect(error.kind).toBe(kind);
    expect(error.isRetryable).toBe(isRetryable);
  });
});
