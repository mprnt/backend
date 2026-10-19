import { RazorpayService } from '../../src/services/razorpayService';

describe('order tagging on a shared Razorpay account', () => {
  it('prefixes the receipt and attaches product and job notes to live orders', async () => {
    const service = new RazorpayService();
    // Force the live (non-mock) path and capture the body without a network call.
    Object.assign(service, { apiKey: 'rzp_live_test', apiSecret: 'secret' });
    const request = jest
      .spyOn(service as unknown as { request: (...a: unknown[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ id: 'order_1', amount: 1000, currency: 'INR', created_at: 1 });

    await service.createOrder({ jobId: 'job-1', amount: 10, currency: 'INR' });

    const body = request.mock.calls[0][2] as { receipt: string; notes: Record<string, string> };
    expect(body.receipt).toMatch(/^mp_job1_\d+$/);
    expect(body.notes).toEqual({ product: 'mprnt-print', job_id: 'job-1' });
  });

  it('keeps the receipt within Razorpay limit of 56 characters for a real job ID', async () => {
    const service = new RazorpayService();
    Object.assign(service, { apiKey: 'rzp_live_test', apiSecret: 'secret' });
    const request = jest
      .spyOn(service as unknown as { request: (...a: unknown[]) => Promise<unknown> }, 'request')
      .mockResolvedValue({ id: 'order_1', amount: 1000, currency: 'INR', created_at: 1 });

    await service.createOrder({
      jobId: 'dc02e41d-cef2-446b-8204-77a7b9629b88',
      amount: 6,
      currency: 'INR',
    });

    const body = request.mock.calls[0][2] as { receipt: string };
    expect(body.receipt.length).toBeLessThanOrEqual(56);
    request.mockRestore();
  });
});
