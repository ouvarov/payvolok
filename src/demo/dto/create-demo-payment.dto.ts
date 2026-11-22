import { IsIn } from 'class-validator';

import {
  PROVIDER_CODES,
  type ProviderCode,
} from '@/providers/provider.constants';

import { DEMO_AMOUNTS_MINOR, type DemoAmountMinor } from '../demo.constants';

export class CreateDemoPaymentDto {
  @IsIn(PROVIDER_CODES)
  readonly provider: ProviderCode;

  @IsIn(DEMO_AMOUNTS_MINOR)
  readonly amountMinor: DemoAmountMinor;
}
