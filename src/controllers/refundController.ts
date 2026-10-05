import { Request, Response } from 'express';
import { refundService } from '../services/refundService';
import { auditService } from '../services/auditService';

class RefundController {
  /**
   * POST /api/v1/admin/print-jobs/:jobId/refund
   * Full refund of a paid job that has not printed. Idempotent.
   */
  async refundJob(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;
    const { reason } = req.body as { reason: string };

    const refund = await refundService.refundJob({
      jobId,
      reason,
      tenantId: req.tenantId ?? null,
      requestedBy: req.admin?.id ?? null,
    });

    if (!refund.alreadyRefunded) {
      await auditService.fromRequest(req, 'payment.refunded', {
        resourceType: 'print_job',
        resourceId: jobId,
        organizationId: refund.organizationId,
        details: {
          refundId: refund.refundId,
          paymentId: refund.paymentId,
          orderId: refund.orderId,
          amount: refund.amount,
          currency: refund.currency,
          reason,
        },
      });
    }

    const { organizationId: _org, ...data } = refund;

    res.json({
      status: 'success',
      message: refund.alreadyRefunded ? 'Refund already issued' : 'Refund issued',
      data,
    });
  }
}

export const refundController = new RefundController();
