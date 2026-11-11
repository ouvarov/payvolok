import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';

import { RouteAccess } from '@/auth/route-access.decorator';

import { PaddleCheckoutService } from './paddle-checkout.service';

// Paddle's default payment link points buyers here; replaced by web/ in 4.1.
@RouteAccess('public')
@Controller('checkout/paddle')
export class PaddleCheckoutController {
  constructor(private readonly paddleCheckoutService: PaddleCheckoutService) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  page(@Res({ passthrough: true }) response: Response): string {
    const page = this.paddleCheckoutService.render();
    response.setHeader('Content-Security-Policy', page.contentSecurityPolicy);

    return page.html;
  }
}
