import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import type {
  AccountRef,
  ProviderAccountsService,
} from '@/provider-accounts/provider-accounts.service';
import type { PaymentProvider } from '@/providers/payment-provider.port';
import type { ProviderRegistry } from '@/providers/provider.registry';

import type { WebhookWorker } from './webhook.worker';
import type { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

const REPLAYED_ID = '7f3c1a52-8d4e-4b6a-9c21-0e5d7a9b3f10';
const HOUR_MS = 60 * 60 * 1000;
const CAP = 20;
const START_EPOCH_MS = 1_000_000;
const ACCOUNT_ID = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7aff';

const accountOf = (provider: string): AccountRef =>
  ({ id: ACCOUNT_ID, projectId: SEED_PROJECT_ID, provider }) as AccountRef;

const accountsServiceWith = (
  seedAccountOf: jest.Mock = jest.fn((provider: string) =>
    Promise.resolve(accountOf(provider)),
  ),
): ProviderAccountsService =>
  ({ seedAccountOf }) as unknown as ProviderAccountsService;

const rejectingProvider = (code: string): PaymentProvider =>
  ({
    code,
    verifyWebhook: () => Promise.resolve(false),
  }) as unknown as PaymentProvider;

const serviceWith = (insertInvalidIfAbsent: jest.Mock): WebhooksService =>
  new WebhooksService(
    accountsServiceWith(),
    {
      find: (code: string) => rejectingProvider(code),
    } as unknown as ProviderRegistry,
    { insertInvalidIfAbsent } as unknown as WebhooksRepository,
    { kick: jest.fn() } as unknown as WebhookWorker,
  );

const acceptingProvider = {
  code: 'fake',
  webhookHeaders: [],
  verifyWebhook: () => Promise.resolve(true),
  parseWebhook: () => [
    { type: 'unknown', rawType: null, dedupKey: 'event-1', occurredAt: null },
  ],
} as unknown as PaymentProvider;

const kickingServiceWith = (
  repository: Partial<Record<keyof WebhooksRepository, jest.Mock>>,
  kick: jest.Mock,
  seedAccountOf?: jest.Mock,
): WebhooksService =>
  new WebhooksService(
    accountsServiceWith(seedAccountOf),
    { find: () => acceptingProvider } as unknown as ProviderRegistry,
    repository as unknown as WebhooksRepository,
    { kick } as unknown as WebhookWorker,
  );

describe('WebhooksService worker kick', () => {
  it.each([
    ['kicks the worker after a new row', true, 1],
    ['does not kick the worker for a deduped delivery', false, 0],
  ])('%s', async (_case, isInserted, kickCount) => {
    const kick = jest.fn();
    const service = kickingServiceWith(
      { insertReceivedIfAbsent: jest.fn().mockResolvedValue(isInserted) },
      kick,
    );

    await service.receive('fake', Buffer.from('{}'), {});

    expect(kick).toHaveBeenCalledTimes(kickCount);
  });

  it('kicks the worker after a replay row and returns its id', async () => {
    const kick = jest.fn();
    const insertReplay = jest.fn().mockResolvedValue('replay-id');
    const service = kickingServiceWith({ insertReplay }, kick);

    await expect(service.replay(REPLAYED_ID)).resolves.toBe('replay-id');
    expect(insertReplay).toHaveBeenCalledWith(REPLAYED_ID);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('returns null without a kick when no replay row is inserted', async () => {
    const kick = jest.fn();
    const service = kickingServiceWith(
      { insertReplay: jest.fn().mockResolvedValue(null) },
      kick,
    );

    await expect(service.replay(REPLAYED_ID)).resolves.toBeNull();
    expect(kick).not.toHaveBeenCalled();
  });

  it('returns null for an id that is not a uuid without a query', async () => {
    const insertReplay = jest.fn();
    const service = kickingServiceWith({ insertReplay }, jest.fn());

    await expect(service.replay('not-a-uuid')).resolves.toBeNull();
    expect(insertReplay).not.toHaveBeenCalled();
  });
});

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

describe('WebhooksService account', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 404 before the signature check and stores no row when the provider has no seed account', async () => {
    const verifyWebhook = jest.fn();
    const insertReceivedIfAbsent = jest.fn();
    const insertInvalidIfAbsent = jest.fn();
    const service = new WebhooksService(
      accountsServiceWith(jest.fn().mockResolvedValue(null)),
      {
        find: () => ({ ...acceptingProvider, verifyWebhook }),
      } as unknown as ProviderRegistry,
      {
        insertReceivedIfAbsent,
        insertInvalidIfAbsent,
      } as unknown as WebhooksRepository,
      { kick: jest.fn() } as unknown as WebhookWorker,
    );

    await expect(
      service.receive('fake', Buffer.from('{}'), {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(verifyWebhook).not.toHaveBeenCalled();
    expect(insertReceivedIfAbsent).not.toHaveBeenCalled();
    expect(insertInvalidIfAbsent).not.toHaveBeenCalled();
  });

  it('answers 503 and stores no row when the account lookup fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const insertReceivedIfAbsent = jest.fn();
    const service = kickingServiceWith(
      { insertReceivedIfAbsent },
      jest.fn(),
      jest.fn().mockRejectedValue(new Error('connection refused')),
    );

    await expect(
      service.receive('fake', Buffer.from('{}'), {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(insertReceivedIfAbsent).not.toHaveBeenCalled();
  });

  it('stores a valid delivery under the seed account of its provider', async () => {
    const seedAccountOf = jest.fn((provider: string) =>
      Promise.resolve(accountOf(provider)),
    );
    const insertReceivedIfAbsent = jest.fn().mockResolvedValue(true);
    const service = kickingServiceWith(
      { insertReceivedIfAbsent },
      jest.fn(),
      seedAccountOf,
    );

    await service.receive('fake', Buffer.from('{}'), {});

    expect(seedAccountOf).toHaveBeenCalledWith('fake');
    expect(insertReceivedIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fake',
        providerAccountId: ACCOUNT_ID,
      }),
    );
  });

  it('stores an invalid delivery under the seed account of its provider', async () => {
    const insertInvalidIfAbsent = jest.fn().mockResolvedValue(undefined);

    await sendInvalid(serviceWith(insertInvalidIfAbsent), 'fake', 1);

    expect(insertInvalidIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fake',
        providerAccountId: ACCOUNT_ID,
      }),
    );
  });
});

describe('WebhooksService invalid signature cap', () => {
  let now: jest.SpyInstance<number, []>;
  let warn: jest.SpyInstance;
  let insertInvalidIfAbsent: jest.Mock;
  let service: WebhooksService;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
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

  it('does not warn up to the cap', async () => {
    await sendInvalid(service, 'fake', CAP);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per window, however many requests pass the cap', async () => {
    await sendInvalid(service, 'fake', CAP + 5);
    expect(warn).toHaveBeenCalledTimes(1);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS);
    await sendInvalid(service, 'fake', CAP + 5);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once for each provider', async () => {
    await sendInvalid(service, 'fake', CAP + 2);
    await sendInvalid(service, 'other', CAP + 2);

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
