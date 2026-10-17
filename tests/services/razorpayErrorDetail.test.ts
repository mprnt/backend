import { gatewayErrorDetail } from '../../src/services/razorpayService';

describe('gatewayErrorDetail', () => {
  it('keeps the code, field, reason and description Razorpay returns', () => {
    const detail = gatewayErrorDetail(400, {
      error: {
        code: 'BAD_REQUEST_ERROR',
        description: 'invalid request sent',
        field: 'amount',
        source: 'business',
        step: 'payment_initiation',
        reason: 'input_validation_failed',
      },
    });

    expect(detail).toEqual({
      status: 400,
      code: 'BAD_REQUEST_ERROR',
      description: 'invalid request sent',
      field: 'amount',
      source: 'business',
      step: 'payment_initiation',
      reason: 'input_validation_failed',
    });
  });

  it('falls back to a generic description when the body has no error object', () => {
    expect(gatewayErrorDetail(502, '<html>bad gateway</html>')).toEqual({
      status: 502,
      description: 'Razorpay API error',
    });
    expect(gatewayErrorDetail(500, { error: 'plain string' }).description).toBe(
      'Razorpay API error'
    );
  });
});
