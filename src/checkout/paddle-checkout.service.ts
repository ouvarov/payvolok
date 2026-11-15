import { randomBytes } from 'node:crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { describeError } from '@/database/postgres-errors';
import {
  ProviderAccountsService,
  type PaddleCheckoutAccount,
} from '@/provider-accounts/provider-accounts.service';

import { checkoutPageOf, type CheckoutPage } from './paddle-checkout-page';

const NONCE_BYTES = 16;

@Injectable()
export class PaddleCheckoutService {
  private readonly logger = new Logger(PaddleCheckoutService.name);
  // Only accounts that exist and are Paddle get here, so the set stays small.
  private readonly accountsLoggedWithoutToken = new Set<string>();

  constructor(
    private readonly providerAccountsService: ProviderAccountsService,
  ) {}

  async render(providerAccountId: string): Promise<CheckoutPage> {
    const account = await this.checkoutAccountOf(providerAccountId);
    if (!account) throw new NotFoundException();
    if (account.clientToken === null) {
      this.logMissingTokenOnce(providerAccountId);
      throw new ServiceUnavailableException();
    }

    return checkoutPageOf(
      { clientToken: account.clientToken, environment: account.environment },
      randomBytes(NONCE_BYTES).toString('base64'),
    );
  }

  private async checkoutAccountOf(
    providerAccountId: string,
  ): Promise<PaddleCheckoutAccount | null> {
    try {
      return await this.providerAccountsService.paddleCheckoutOf(
        providerAccountId,
      );
    } catch (error) {
      this.logger.warn(
        `Paddle checkout token lookup failed for account ${providerAccountId}: ${describeError(error)}`,
      );
      throw new ServiceUnavailableException();
    }
  }

  // The page is public, so a per-request error line would let anyone flood the log.
  private logMissingTokenOnce(providerAccountId: string): void {
    if (this.accountsLoggedWithoutToken.has(providerAccountId)) return;

    this.accountsLoggedWithoutToken.add(providerAccountId);
    this.logger.error(
      `Paddle checkout page requested but paddle account ${providerAccountId} has no client token`,
    );
  }
}
