import { Logger, UnauthorizedException } from '@nestjs/common';

import type { PaymentProvider } from '@/providers/payment-provider.port';
import type { ProviderRegistry } from '@/providers/provider.registry';

import type { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

const HOUR_MS = 60 * 60 * 1000;
const CAP = 20;
const START_EPOCH_MS = 1_000_000;

const rejectingProvider = (code: string): PaymentProvider =>
  ({
    code,
    verifyWebhook: () => Promise.resolve(false),
  }) as unknown as PaymentProvider;

const serviceWith = (insertInvalidIfAbsent: jest.Mock): WebhooksService =>
  new WebhooksService(
    {
      find: (code: string) => rejectingProvider(code),
    } as unknown as ProviderRegistry,
    { insertInvalidIfAbsent } as unknown as WebhooksRepository,
  );

const sendInvalid = async (
  service: WebhooksService,
  providerCode: string,
  count: number,
): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await expect(
      service.receive(providerCode, Buffer.from(`body-${index}`), {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  }
};

describe('WebhooksService invalid signature cap', () => {
  let now: jest.SpyInstance<number, []>;
  let insertInvalidIfAbsent: jest.Mock;
  let service: WebhooksService;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    now = jest.spyOn(Date, 'now').mockReturnValue(START_EPOCH_MS);
    insertInvalidIfAbsent = jest.fn().mockResolvedValue(undefined);
    service = serviceWith(insertInvalidIfAbsent);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores no row past the cap within the hour', async () => {
    await sendInvalid(service, 'fake', CAP + 1);

    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP);
  });

  it('stores rows again once the hour has passed', async () => {
    await sendInvalid(service, 'fake', CAP + 1);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS - 1);
    await sendInvalid(service, 'fake', 1);
    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS);
    await sendInvalid(service, 'fake', 1);
    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP + 1);
  });

  it('counts each provider on its own', async () => {
    await sendInvalid(service, 'fake', CAP + 1);
    await sendInvalid(service, 'other', 1);

    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP + 1);
  });
});
