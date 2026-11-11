import { Request, Response } from 'express';
import { physicalOutcomeService } from '../services/physicalOutcomeService';
import { auditService } from '../services/auditService';

class PhysicalOutcomeController {
  /**
   * GET /api/v1/admin/print-jobs/:jobId/physical-outcome
   * Attempts, evidence and the recorded outcome, for an operator to reconcile.
   */
  async getForOperator(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;
    const data = await physicalOutcomeService.getForOperator(jobId);
    res.json({ status: 'success', data });
  }

  /**
   * POST /api/v1/admin/print-jobs/:jobId/physical-outcome
   * Operator-verified outcome. Recorded once; the same outcome again is a no-op.
   */
  async recordOutcome(req: Request, res: Response): Promise<void> {
    const { jobId } = req.params;
    const body = req.body as {
      outcome: 'printed' | 'partial' | 'blank' | 'not_printed';
      verifiedPages: number | null;
      method: string;
      reason: string;
      attemptFindings: Array<{
        attempt: number;
        printerId: string | null;
        finding:
          | 'never_submitted'
          | 'cups_completed_printed'
          | 'cups_completed_partial'
          | 'cups_completed_blank'
          | 'cups_failed'
          | 'unknown';
      }>;
    };

    const result = await physicalOutcomeService.recordOperatorOutcome({
      jobId,
      outcome: body.outcome,
      verifiedPages: body.verifiedPages,
      method: body.method,
      reason: body.reason,
      attemptFindings: body.attemptFindings,
      operatorId: req.admin?.id ?? null,
    });

    if (result.applied) {
      await auditService.fromRequest(req, 'print_job.physical_outcome_recorded', {
        resourceType: 'print_job',
        resourceId: jobId,
        details: {
          outcome: body.outcome,
          verifiedPages: body.verifiedPages,
          method: body.method,
          reason: body.reason,
          attemptFindings: body.attemptFindings,
        },
      });
    }

    res.json({
      status: 'success',
      message: result.applied ? 'Physical outcome recorded' : 'Physical outcome already recorded',
      data: {
        jobId,
        applied: result.applied,
        physicalOutcome: result.physicalOutcome,
        verifiedPages: result.verifiedPages,
      },
    });
  }
}

export const physicalOutcomeController = new PhysicalOutcomeController();
