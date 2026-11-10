import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import {
  PROVIDER_CODES,
  type ProviderCode,
} from '@/providers/provider.constants';

import { CURRENCY_PATTERN } from '../payment.constants';

const DESCRIPTION_MAX_LENGTH = 255;
const RETURN_URL_MAX_LENGTH = 2048;

export class CreatePaymentDto {
  @IsIn(PROVIDER_CODES)
  readonly provider: ProviderCode;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  readonly amountMinor: number;

  @IsString()
  @Matches(CURRENCY_PATTERN)
  readonly currency: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(DESCRIPTION_MAX_LENGTH)
  readonly description: string;

  @IsUrl({
    protocols: ['http', 'https'],
    require_protocol: true,
    require_tld: false,
  })
  @MaxLength(RETURN_URL_MAX_LENGTH)
  readonly returnUrl: string;
}
