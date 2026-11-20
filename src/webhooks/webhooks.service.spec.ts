import {
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';

import { SEED_PROJECT_ID } from '@/projects/projects.constants';
import type { ProviderAccountsService } from '@/provider-accounts/provider-accounts.service';
import type { BoundProvider } from '@/providers/payment-provider.port';

import type { WebhookWorker } from './webhook.worker';
import type { WebhooksRepository } from './webhooks.repository';
import { WebhooksService } from './webhooks.service';

const REPLAYED_ID = '7f3c1a52-8d4e-4b6a-9c21-0e5d7a9b3f10';
const HOUR_MS = 60 * 60 * 1000;
const CAP = 20;
const START_EPOCH_MS = 1_000_000;
const ACCOUNT_ID = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7aff';
const OTHER_ACCOUNT_ID = '5e3d0c1a-0b7e-4c52-9a51-3f0f6c2d7afe';

const boundProviderWith = (
  accountId: string,
  overrides: Partial<BoundProvider> = {},
): BoundProvider =>
  ({
    accountId,
    projectId: SEED_PROJECT_ID,
    code: 'fake',
    webhookHeaders: [],
    verifyWebhook: () => Promise.resolve(true),
    parseWebhook: () => [
      { type: 'unknown', rawType: null, dedupKey: 'event-1', occurredAt: null },
    ],
    ...overrides,
  }) as BoundProvider;

const rejectingProviderOf = (accountId: string): BoundProvider =>
  boundProviderWith(accountId, {
    verifyWebhook: () => Promise.resolve(false),
  });

const serviceWith = (
  bindForWebhook: jest.Mock,
  repository: Partial<Record<keyof WebhooksRepository, jest.Mock>> = {},
  kick: jest.Mock = jest.fn(),
): WebhooksService =>
  new WebhooksService(
    { bindForWebhook } as unknown as ProviderAccountsService,
    repository as unknown as WebhooksRepository,
    { kick } as unknown as WebhookWorker,
  );

const bindingTo = (provider: BoundProvider | null): jest.Mock =>
  jest.fn().mockResolvedValue(provider);

describe('WebhooksService worker kick', () => {
  it.each([
    ['kicks the worker after a new row', true, 1],
    ['does not kick the worker for a deduped delivery', false, 0],
  ])('%s', async (_case, isInserted, kickCount) => {
    const kick = jest.fn();
    const service = serviceWith(
      bindingTo(boundProviderWith(ACCOUNT_ID)),
      { insertReceivedIfAbsent: jest.fn().mockResolvedValue(isInserted) },
      kick,
    );

    await service.receive('fake', ACCOUNT_ID, Buffer.from('{}'), {});

    expect(kick).toHaveBeenCalledTimes(kickCount);
  });

  it('kicks the worker after a replay row and returns its id', async () => {
    const kick = jest.fn();
    const insertReplay = jest.fn().mockResolvedValue('replay-id');
    const service = serviceWith(jest.fn(), { insertReplay }, kick);

    await expect(service.replay(REPLAYED_ID)).resolves.toBe('replay-id');
    expect(insertReplay).toHaveBeenCalledWith(REPLAYED_ID);
    expect(kick).toHaveBeenCalledTimes(1);
  });

  it('returns null without a kick when no replay row is inserted', async () => {
    const kick = jest.fn();
    const service = serviceWith(
      jest.fn(),
      { insertReplay: jest.fn().mockResolvedValue(null) },
      kick,
    );

    await expect(service.replay(REPLAYED_ID)).resolves.toBeNull();
    expect(kick).not.toHaveBeenCalled();
  });

  it('returns null for an id that is not a uuid without a query', async () => {
    const insertReplay = jest.fn();
    const service = serviceWith(jest.fn(), { insertReplay });

    await expect(service.replay('not-a-uuid')).resolves.toBeNull();
    expect(insertReplay).not.toHaveBeenCalled();
  });
});

const sendInvalid = async (
  service: WebhooksService,
  accountId: string,
  count: number,
): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await expect(
      service.receive('fake', accountId, Buffer.from(`body-${index}`), {}),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  }
};

describe('WebhooksService account', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('answers 404 for an unknown provider without a lookup', async () => {
    const bindForWebhook = jest.fn();

    await expect(
      serviceWith(bindForWebhook).receive(
        'liqpay',
        ACCOUNT_ID,
        Buffer.from('{}'),
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(bindForWebhook).not.toHaveBeenCalled();
  });

  it('answers 404 before the signature check and stores no row when the URL names no account of the provider', async () => {
    const insertReceivedIfAbsent = jest.fn();
    const insertInvalidIfAbsent = jest.fn();
    const service = serviceWith(bindingTo(null), {
      insertReceivedIfAbsent,
      insertInvalidIfAbsent,
    });

    await expect(
      service.receive('fake', ACCOUNT_ID, Buffer.from('{}'), {}),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(insertReceivedIfAbsent).not.toHaveBeenCalled();
    expect(insertInvalidIfAbsent).not.toHaveBeenCalled();
  });

  it('answers 503 and stores no row when the account lookup fails', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const insertReceivedIfAbsent = jest.fn();
    const service = serviceWith(
      jest.fn().mockRejectedValue(new Error('connection refused')),
      { insertReceivedIfAbsent },
    );

    await expect(
      service.receive('fake', ACCOUNT_ID, Buffer.from('{}'), {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(insertReceivedIfAbsent).not.toHaveBeenCalled();
  });

  it('stores a valid delivery under the account of the URL', async () => {
    const bindForWebhook = bindingTo(boundProviderWith(ACCOUNT_ID));
    const insertReceivedIfAbsent = jest.fn().mockResolvedValue(true);
    const service = serviceWith(bindForWebhook, { insertReceivedIfAbsent });

    await service.receive('fake', ACCOUNT_ID, Buffer.from('{}'), {});

    expect(bindForWebhook).toHaveBeenCalledWith('fake', ACCOUNT_ID);
    expect(insertReceivedIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'fake',
        providerAccountId: ACCOUNT_ID,
      }),
    );
  });

  it('stores an invalid delivery under the account of the URL', async () => {
    const insertInvalidIfAbsent = jest.fn().mockResolvedValue(undefined);
    const service = serviceWith(bindingTo(rejectingProviderOf(ACCOUNT_ID)), {
      insertInvalidIfAbsent,
    });

    await sendInvalid(service, ACCOUNT_ID, 1);

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
    service = serviceWith(
      jest.fn((_provider: string, accountId: string) =>
        Promise.resolve(rejectingProviderOf(accountId)),
      ),
      { insertInvalidIfAbsent },
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stores no row past the cap within the hour', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP + 1);

    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP);
  });

  it('stores rows again once the hour has passed', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP + 1);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS - 1);
    await sendInvalid(service, ACCOUNT_ID, 1);
    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS);
    await sendInvalid(service, ACCOUNT_ID, 1);
    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP + 1);
  });

  it('counts each account of one provider on its own', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP + 1);
    await sendInvalid(service, OTHER_ACCOUNT_ID, 1);

    expect(insertInvalidIfAbsent).toHaveBeenCalledTimes(CAP + 1);
    expect(insertInvalidIfAbsent).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerAccountId: OTHER_ACCOUNT_ID }),
    );
  });

  it('does not warn up to the cap', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per window, however many requests pass the cap', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP + 5);
    expect(warn).toHaveBeenCalledTimes(1);

    now.mockReturnValue(START_EPOCH_MS + HOUR_MS);
    await sendInvalid(service, ACCOUNT_ID, CAP + 5);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns once for each account', async () => {
    await sendInvalid(service, ACCOUNT_ID, CAP + 2);
    await sendInvalid(service, OTHER_ACCOUNT_ID, CAP + 2);

    expect(warn).toHaveBeenCalledTimes(2);
  });
});
