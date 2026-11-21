import { Controller, Get, Header, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RouteAccess } from '@/auth/route-access.decorator';

import type { CheckoutPage } from './paddle-checkout-page';
import { PaddleCheckoutService } from './paddle-checkout.service';

const sendPage = (response: Response, page: CheckoutPage): string => {
  response.setHeader('Content-Security-Policy', page.contentSecurityPolicy);

  return page.html;
};

// Paddle's default payment link points buyers here.
@RouteAccess('public')
@Controller('checkout/paddle')
export class PaddleCheckoutController {
  constructor(private readonly paddleCheckoutService: PaddleCheckoutService) {}

  @Get(':providerAccountId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  // Paddle.js checks the page's domain through the referrer.
  @Header('Referrer-Policy', 'strict-origin-when-cross-origin')
  // 3-D Secure and PayPal open popups that must keep a handle to this page.
  @Header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
  async page(
    @Param('providerAccountId') providerAccountId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    return sendPage(
      response,
      await this.paddleCheckoutService.render(providerAccountId),
    );
  }
}
