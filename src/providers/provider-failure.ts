import {
  MAX_FAILURE_REASON_LENGTH,
  storableText,
} from '@/common/storable-text';
import { describeError } from '@/database/postgres-errors';

import { ProviderError, type ProviderErrorKind } from './payment-provider.port';

type ProviderFailure = { kind: ProviderErrorKind; detail: string };

const providerFailureOf = (error: unknown): ProviderFailure =>
  error instanceof ProviderError
    ? {
        kind: error.kind,
        detail: storableText(error.message, MAX_FAILURE_REASON_LENGTH),
      }
    : { kind: 'unavailable', detail: describeError(error) };

export { providerFailureOf };
export type { ProviderFailure };
