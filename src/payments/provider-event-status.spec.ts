import { PAYMENT_STATUS_BY_EVENT_TYPE } from './provider-event-status';

describe('PAYMENT_STATUS_BY_EVENT_TYPE', () => {
  it('keeps a failed attempt pending because the provider may still retry', () => {
    expect(PAYMENT_STATUS_BY_EVENT_TYPE['payment.attempt_failed']).toBe(
      'pending',
    );
  });

  it('maps a final failure to failed', () => {
    expect(PAYMENT_STATUS_BY_EVENT_TYPE['payment.failed']).toBe('failed');
  });

  it('maps the remaining payment events to their own status', () => {
    expect(PAYMENT_STATUS_BY_EVENT_TYPE).toMatchObject({
      'payment.pending': 'pending',
      'payment.succeeded': 'succeeded',
      'payment.expired': 'expired',
    });
  });
});
