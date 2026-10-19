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
    expect(body.receipt).toMatch(/^mprnt_job_job-1_\d+$/);
    expect(body.notes).toEqual({ product: 'mprnt-print', job_id: 'job-1' });
    request.mockRestore();
  });
});
