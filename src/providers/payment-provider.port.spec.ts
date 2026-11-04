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

  it('keeps the wrapped error as its cause', () => {
    const fetchFailure = new TypeError('fetch failed');

    const error = new ProviderError('test', {
      providerCode: 'fake',
      kind: 'unavailable',
      cause: fetchFailure,
    });

    expect(error.cause).toBe(fetchFailure);
  });

  it('has no cause property when none is given', () => {
    const error = new ProviderError('test', {
      providerCode: 'fake',
      kind: 'rejected',
    });

    expect(Object.hasOwn(error, 'cause')).toBe(false);
  });
});
