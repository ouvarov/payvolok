type Checkout = { type: 'redirect'; url: string };

export class CreatedPaymentResponseDto {
  readonly paymentId: string;
  readonly checkout: Checkout;

  constructor(paymentId: string, redirectUrl: string) {
    this.paymentId = paymentId;
    this.checkout = { type: 'redirect', url: redirectUrl };
  }
}
