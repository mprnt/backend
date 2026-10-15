import { Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { billingService, toShopContract } from '../services/billingService';

/** Where the change came from. Recorded in the audit row, never trusted for anything else. */
function requestMeta(req: Request): { ipAddress?: string; userAgent?: string } {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

interface SettleBody {
  action: 'paid' | 'waive';
  method?: 'bank_transfer' | 'upi' | 'cash' | 'cheque' | 'other';
  reference?: string | null;
  note?: string | null;
}

/**
 * Model 1 billing endpoints. Reads go through tenant scoping; every write is a
 * super-admin action (enforced in the route as well as here) and is audited.
 */
class BillingController {
  async listPlans(_req: Request, res: Response): Promise<void> {
    const plans = await billingService.listPlans();
    res.json({ status: 'success', data: { plans } });
  }

  async setPlan(req: Request, res: Response): Promise<void> {
    const body = req.body as {
      hardwarePrice: number;
      monthlyPrice: number;
      freeMonths: number;
      graceDays: number;
      effectiveFrom?: string;
      note: string;
    };
    const result = await billingService.setPlan({
      request: requestMeta(req),
      hardwarePrice: body.hardwarePrice,
      monthlyPrice: body.monthlyPrice,
      freeMonths: body.freeMonths,
      graceDays: body.graceDays,
      effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
      note: body.note,
      actorId: req.admin!.id,
    });
    res.status(201).json({
      status: 'success',
      data: { id: result.id, effectiveFrom: result.effectiveFrom.toISOString() },
    });
  }

  /**
   * GET /admin/billing/contract. A shop gets its own contract without internal
   * detail; a super admin names the partner and gets everything.
   */
  async getContract(req: Request, res: Response): Promise<void> {
    const orgId = req.tenantId;
    if (!orgId) throw new AppError('organizationId is required', 400);

    const isSuper = Boolean(req.admin?.isSuperAdmin);
    const view = await billingService.getContract(orgId, { includeInternal: isSuper });

    if (!isSuper) {
      // The shop sees its own invoices and dates. The commercial model, the
      // people who set the terms and the payment references stay internal.
      res.json({
        status: 'success',
        data: {
          hasContract: view.contract !== null,
          contract: view.contract ? toShopContract(view.contract) : null,
        },
      });
      return;
    }
    res.json({ status: 'success', data: view });
  }

  async listContracts(_req: Request, res: Response): Promise<void> {
    const result = await billingService.listContracts();
    res.json({ status: 'success', data: result });
  }

  async recordSale(req: Request, res: Response): Promise<void> {
    const body = req.body as { organizationId: string; note: string };
    const result = await billingService.recordSale({
      request: requestMeta(req),
      organizationId: body.organizationId,
      note: body.note,
      actorId: req.admin!.id,
    });
    res.status(201).json({ status: 'success', data: result });
  }

  async markLive(req: Request, res: Response): Promise<void> {
    const body = req.body as { organizationId: string; goLiveOn: string; note: string };
    const result = await billingService.markLive({
      request: requestMeta(req),
      organizationId: body.organizationId,
      goLiveOn: body.goLiveOn,
      note: body.note,
      actorId: req.admin!.id,
    });
    res.json({ status: 'success', data: result });
  }

  async settleCharge(req: Request, res: Response): Promise<void> {
    const { chargeId } = req.params as { chargeId: string };
    const body = req.body as SettleBody;
    const result = await billingService.settleCharge({
      request: requestMeta(req),
      chargeId,
      action: body.action,
      method: body.method,
      reference: body.reference ?? null,
      note: body.note ?? null,
      actorId: req.admin!.id,
    });
    res.json({ status: 'success', data: result });
  }
}

export const billingController = new BillingController();
