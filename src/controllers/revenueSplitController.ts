import { Request, Response } from 'express';
import { AppError } from '../utils/errors';
import { auditService } from '../services/auditService';
import { platformSharePct, revenueSplitService } from '../services/revenueSplitService';
import { ReportPeriod } from '../types/admin';

/** A term may start now, or later. It may not start in the past: that would rewrite what is already true. */
const BACKDATE_TOLERANCE_MS = 60 * 1000;

interface SetSplitBody {
  organizationId: string;
  kioskId?: string | null;
  partnerSharePct: number;
  effectiveFrom?: string;
  note: string;
}

class RevenueSplitController {
  /**
   * GET /admin/revenue-split
   * The caller's own partner split. A super admin passes ?organizationId=.
   * Shops read it through resolveTenant, so they can only ever see their own.
   */
  async getSplit(req: Request, res: Response): Promise<void> {
    const orgId = req.tenantId;
    if (!orgId) throw new AppError('organizationId is required', 400);

    const view = await revenueSplitService.getView(orgId, Boolean(req.admin?.isSuperAdmin));
    res.json({ status: 'success', data: view });
  }

  /**
   * GET /admin/revenue-split/summary?period=
   * Revenue for the period, and how it divides between partner and MPrnt.
   */
  async getSplitSummary(req: Request, res: Response): Promise<void> {
    const orgId = req.tenantId;
    if (!orgId) throw new AppError('organizationId is required', 400);

    const period = (req.query.period as ReportPeriod | undefined) ?? 'month';
    const summary = await revenueSplitService.getSummary(orgId, period);
    res.json({ status: 'success', data: summary });
  }

  /**
   * POST /admin/revenue-split
   * Super admins only (enforced in the route). Records a term, for the partner
   * or for one QR point. Every term is audited with the value it replaced.
   */
  async setSplit(req: Request, res: Response): Promise<void> {
    const body = req.body as SetSplitBody;

    const effectiveFrom = body.effectiveFrom ? new Date(body.effectiveFrom) : null;
    if (effectiveFrom && effectiveFrom.getTime() < Date.now() - BACKDATE_TOLERANCE_MS) {
      throw new AppError('A revenue split cannot start in the past', 400);
    }

    const result = await revenueSplitService.setTerm({
      organizationId: body.organizationId,
      kioskId: body.kioskId ?? null,
      partnerSharePct: body.partnerSharePct,
      effectiveFrom,
      note: body.note,
      actorId: req.admin!.id,
    });

    await auditService.fromRequest(req, 'revenue_split.set', {
      resourceType: 'revenue_split_term',
      resourceId: result.id,
      organizationId: body.organizationId,
      details: {
        scope: body.kioskId ? 'qr_point' : 'partner',
        kioskId: body.kioskId ?? null,
        partnerSharePct: body.partnerSharePct,
        platformSharePct: platformSharePct(body.partnerSharePct),
        previousPartnerSharePct: result.previous,
        effectiveFrom: result.effectiveFrom.toISOString(),
        note: body.note.trim(),
      },
    });

    res.status(201).json({
      status: 'success',
      data: { id: result.id, effectiveFrom: result.effectiveFrom.toISOString() },
    });
  }
}

export const revenueSplitController = new RevenueSplitController();
