import { IsInt, Max, Min } from 'class-validator';

export class CreateRefundDto {
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  readonly amountMinor: number;
}
