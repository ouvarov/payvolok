import { storableHeaders } from './webhook-headers';

const PROVIDER_HEADERS = ['x-provider-signature'];

describe('storableHeaders', () => {
  it.each([
    'authorization',
    'x-authorization',
    'cookie',
    'set-cookie',
    'proxy-authorization',
    'forwarded',
    'x-forwarded-for',
    'x-real-ip',
    'true-client-ip',
    'cf-connecting-ip',
    'x-session-id',
    'x-auth-token',
    'x-client-secret',
    'api_key',
    'x-api-key',
    'x-request-id',
    'x-anything-unknown',
  ])('drops %s', (name) => {
    expect(storableHeaders({ [name]: 'value' }, PROVIDER_HEADERS)).toEqual({});
  });

  it.each([
    'content-type',
    'content-length',
    'user-agent',
    'x-provider-signature',
  ])('keeps %s', (name) => {
    expect(storableHeaders({ [name]: 'value' }, PROVIDER_HEADERS)).toEqual({
      [name]: 'value',
    });
  });

  it('drops a header another provider declares', () => {
    expect(storableHeaders({ 'x-provider-signature': 'value' }, [])).toEqual(
      {},
    );
  });

  it('keeps a repeated header as an array and skips an undefined value', () => {
    expect(
      storableHeaders(
        { 'x-provider-signature': ['one', 'two'], 'user-agent': undefined },
        PROVIDER_HEADERS,
      ),
    ).toEqual({ 'x-provider-signature': ['one', 'two'] });
  });
});
