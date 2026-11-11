import { randomBytes } from 'node:crypto';

import { Logger, ServiceUnavailableException } from '@nestjs/common';

import { checkoutPageOf, type CheckoutPage } from './paddle-checkout-page';

const NONCE_BYTES = 16;

export class PaddleCheckoutService {
  private readonly logger = new Logger(PaddleCheckoutService.name);
  private hasLoggedMissingToken = false;

  constructor(private readonly clientToken: string | null) {}

  render(): CheckoutPage {
    if (this.clientToken === null) {
      this.logMissingTokenOnce();
      throw new ServiceUnavailableException();
    }

    return checkoutPageOf(
      this.clientToken,
      randomBytes(NONCE_BYTES).toString('base64'),
    );
  }

  // The page is public, so a per-request error line would let anyone flood the log.
  private logMissingTokenOnce(): void {
    if (this.hasLoggedMissingToken) return;

    this.hasLoggedMissingToken = true;
    this.logger.error(
      'Paddle checkout page requested but PADDLE_CLIENT_TOKEN is not set',
    );
  }
}
