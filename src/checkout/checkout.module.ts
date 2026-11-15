import { Module } from '@nestjs/common';

import { ProviderAccountsModule } from '@/provider-accounts/provider-accounts.module';

import { PaddleCheckoutController } from './paddle-checkout.controller';
import { PaddleCheckoutService } from './paddle-checkout.service';

@Module({
  imports: [ProviderAccountsModule],
  controllers: [PaddleCheckoutController],
  providers: [PaddleCheckoutService],
})
export class CheckoutModule {}
