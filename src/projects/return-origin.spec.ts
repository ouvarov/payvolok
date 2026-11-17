import { isReturnOriginAllowed } from './return-origin';

const ALLOWED = ['https://shop.example'];

describe('isReturnOriginAllowed', () => {
  it.each([
    'https://shop.example/return',
    'https://shop.example/',
    'https://shop.example:443/return?order=42',
    'https://SHOP.example/return',
  ])('accepts %s for https://shop.example', (returnUrl) => {
    expect(isReturnOriginAllowed(returnUrl, ALLOWED)).toBe(true);
  });

  it.each([
    ['a longer host', 'https://shop.example.evil.test/return'],
    ['another scheme', 'http://shop.example/return'],
    ['another port', 'https://shop.example:8443/return'],
    ['user info before another host', 'https://shop.example@evil.test/return'],
    ['a subdomain', 'https://pay.shop.example/return'],
    ['not a URL', 'shop.example/return'],
  ])('refuses %s', (_case, returnUrl) => {
    expect(isReturnOriginAllowed(returnUrl, ALLOWED)).toBe(false);
  });

  it('refuses every URL when the list is empty', () => {
    expect(isReturnOriginAllowed('https://shop.example/return', [])).toBe(
      false,
    );
  });

  it('compares with the origin of an entry that carries a path', () => {
    expect(
      isReturnOriginAllowed('https://shop.example/return', [
        'https://shop.example/some/path',
      ]),
    ).toBe(true);
  });

  it('matches no entry that is not a URL', () => {
    expect(
      isReturnOriginAllowed('https://shop.example/return', ['shop.example']),
    ).toBe(false);
  });
});
