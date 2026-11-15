import { FakeProvider } from './fake/fake.provider';
import { PaddleProvider } from './paddle/paddle.provider';
import { ProviderError } from './payment-provider.port';
import { RedactedSecret } from './provider-credentials';
import { ProviderRegistry } from './provider.registry';

const SECRET = new RedactedSecret('s'.repeat(32));
const FAKE_ACCOUNT = {
  id: '0b9d6f0e-5a4b-4c1e-9f3a-aaaaaaaaaaaa',
  projectId: '0b9d6f0e-5a4b-4c1e-9f3a-bbbbbbbbbbbb',
  provider: 'fake' as const,
};
const FAKE_CREDENTIALS = {
  provider: 'fake' as const,
  webhookSecrets: [SECRET],
};
const RAW_BODY = Buffer.from('{"eventId":"event-1"}');

describe('ProviderRegistry', () => {
  const fakeProvider = new FakeProvider();
  const paddleProvider = new PaddleProvider();
  const registry = new ProviderRegistry(fakeProvider, paddleProvider);

  it('binds an account to its adapter, ids and credentials', async () => {
    const bound = registry.bind(FAKE_ACCOUNT, FAKE_CREDENTIALS);

    expect(bound).toMatchObject({
      accountId: FAKE_ACCOUNT.id,
      projectId: FAKE_ACCOUNT.projectId,
      code: 'fake',
      capabilities: fakeProvider.capabilities,
      webhookHeaders: fakeProvider.webhookHeaders,
    });
    await expect(
      bound.verifyWebhook(fakeProvider.signRawBody(SECRET, RAW_BODY)),
    ).resolves.toBe(true);
  });

  it('binds a Paddle account to the Paddle adapter', () => {
    const bound = registry.bind(
      { ...FAKE_ACCOUNT, provider: 'paddle' },
      {
        provider: 'paddle',
        environment: 'sandbox',
        apiKey: null,
        webhookSecrets: [],
        clientToken: null,
      },
    );

    expect(bound.code).toBe('paddle');
    expect(bound.capabilities).toBe(paddleProvider.capabilities);
  });

  it('refuses credentials of another provider as misconfigured', () => {
    const error = (() => {
      try {
        return registry.bind(
          { ...FAKE_ACCOUNT, provider: 'paddle' },
          FAKE_CREDENTIALS,
        );
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      providerCode: 'paddle',
      kind: 'misconfigured',
    });
  });

  it('reads the refund identity from the adapter capabilities', () => {
    const referenceProvider = Object.assign(new FakeProvider(), {
      capabilities: {
        ...fakeProvider.capabilities,
        refundIdentity: 'reference' as const,
      },
    });

    expect(registry.refundIdentityOf('fake')).toBe('provider');
    expect(registry.refundIdentityOf('paddle')).toBe('provider');
    expect(
      new ProviderRegistry(referenceProvider, paddleProvider).refundIdentityOf(
        'fake',
      ),
    ).toBe('reference');
  });
});
