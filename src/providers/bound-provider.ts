import type { BoundProvider, PaymentProvider } from './payment-provider.port';

type BoundAccountIds = { id: string; projectId: string };

const boundProviderOf = <Credentials>(
  account: BoundAccountIds,
  adapter: PaymentProvider<Credentials>,
  credentials: Credentials,
): BoundProvider => ({
  accountId: account.id,
  projectId: account.projectId,
  code: adapter.code,
  capabilities: adapter.capabilities,
  webhookHeaders: adapter.webhookHeaders,
  createPayment: (input) => adapter.createPayment(credentials, input),
  refund: (input) => adapter.refund(credentials, input),
  getStatus: (query) => adapter.getStatus(credentials, query),
  listRefunds: (providerPaymentId) =>
    adapter.listRefunds(credentials, providerPaymentId),
  verifyWebhook: (request) => adapter.verifyWebhook(credentials, request),
  parseWebhook: (request) => adapter.parseWebhook(request),
});

export { boundProviderOf };
export type { BoundAccountIds };
