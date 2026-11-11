import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { PaddleCheckoutService } from './paddle-checkout.service';

const CLIENT_TOKEN = `test_${'a1B'.repeat(9)}`;

const nonceOf = (contentSecurityPolicy: string): string | undefined =>
  /script-src 'nonce-([^']+)'/.exec(contentSecurityPolicy)?.[1];

describe('PaddleCheckoutService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Paddle.js in sandbox mode with the token and a matching nonce', () => {
    const page = new PaddleCheckoutService(CLIENT_TOKEN).render();
    const nonce = nonceOf(page.contentSecurityPolicy);

    expect(nonce).toEqual(expect.any(String));
    expect(page.html).toContain(
      `<script nonce="${nonce}" src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>`,
    );
    expect(page.html).toContain(`<script nonce="${nonce}">`);
    expect(page.html).toContain("Paddle.Environment.set('sandbox');");
    expect(page.html).toContain(
      `Paddle.Initialize({ token: "${CLIENT_TOKEN}" });`,
    );
    expect(page.contentSecurityPolicy).toContain("default-src 'none'");
  });

  it('uses a fresh nonce for every page', () => {
    const service = new PaddleCheckoutService(CLIENT_TOKEN);

    expect(nonceOf(service.render().contentSecurityPolicy)).not.toBe(
      nonceOf(service.render().contentSecurityPolicy),
    );
  });

  it('answers 503 on every request without a client token but logs the error once', () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = new PaddleCheckoutService(null);

    for (let request = 0; request < 3; request += 1) {
      expect(() => service.render()).toThrow(ServiceUnavailableException);
    }
    expect(error).toHaveBeenCalledTimes(1);
  });
});
