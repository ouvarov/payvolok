import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { SEED_PADDLE_ACCOUNT_ID } from '@/provider-accounts/provider-accounts.constants';
import type { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';

import { PaddleCheckoutService } from './paddle-checkout.service';

const CLIENT_TOKEN = `test_${'a1B'.repeat(9)}`;
const OTHER_ACCOUNT_ID = '0b9d6f0e-5a4b-4c1e-9f3a-cccccccccccc';

const nonceOf = (contentSecurityPolicy: string): string | undefined =>
  /script-src 'nonce-([^']+)'/.exec(contentSecurityPolicy)?.[1];

const serviceWith = (paddleClientTokenOf: jest.Mock): PaddleCheckoutService =>
  new PaddleCheckoutService({
    paddleClientTokenOf,
  } as unknown as ProviderAccountsService);

describe('PaddleCheckoutService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders Paddle.js in sandbox mode with the account token and a matching nonce', async () => {
    const paddleClientTokenOf = jest.fn().mockResolvedValue(CLIENT_TOKEN);

    const page = await serviceWith(paddleClientTokenOf).render(
      SEED_PADDLE_ACCOUNT_ID,
    );
    const nonce = nonceOf(page.contentSecurityPolicy);

    expect(paddleClientTokenOf).toHaveBeenCalledWith(SEED_PADDLE_ACCOUNT_ID);
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

  it('uses a fresh nonce for every page', async () => {
    const service = serviceWith(jest.fn().mockResolvedValue(CLIENT_TOKEN));

    const firstPage = await service.render(SEED_PADDLE_ACCOUNT_ID);
    const secondPage = await service.render(SEED_PADDLE_ACCOUNT_ID);

    expect(nonceOf(firstPage.contentSecurityPolicy)).not.toBe(
      nonceOf(secondPage.contentSecurityPolicy),
    );
  });

  it('answers 404 for an account that is not a Paddle account', async () => {
    await expect(
      serviceWith(jest.fn().mockResolvedValue(undefined)).render(
        OTHER_ACCOUNT_ID,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('answers 503 on every request without a client token but logs once per account', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const service = serviceWith(jest.fn().mockResolvedValue(null));

    for (const accountId of [
      SEED_PADDLE_ACCOUNT_ID,
      SEED_PADDLE_ACCOUNT_ID,
      OTHER_ACCOUNT_ID,
      OTHER_ACCOUNT_ID,
    ]) {
      await expect(service.render(accountId)).rejects.toThrow(
        ServiceUnavailableException,
      );
    }
    expect(error).toHaveBeenCalledTimes(2);
    expect(
      error.mock.calls.map(([message]: unknown[]) => String(message)),
    ).toEqual([
      expect.stringContaining(SEED_PADDLE_ACCOUNT_ID),
      expect.stringContaining(OTHER_ACCOUNT_ID),
    ]);
  });

  it('answers 503 when the token lookup fails', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    await expect(
      serviceWith(jest.fn().mockRejectedValue(new Error('down'))).render(
        SEED_PADDLE_ACCOUNT_ID,
      ),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
