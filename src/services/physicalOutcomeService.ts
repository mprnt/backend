import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * What came out of the printer, kept apart from the job's status.
 *
 * - The printer may only attach CUPS evidence. Evidence is append-only and never
 *   changes the outcome: a CUPS success does not prove output, and a CUPS failure
 *   does not prove none came out.
 * - Only an operator can record an outcome, once, after the job is final. The
 *   operator must account for every attempt. Their verified page count is always
 *   a fact, never inferred from CUPS.
 */

export type PhysicalOutcome = 'unknown' | 'printed' | 'partial' | 'blank' | 'not_printed';

export type AttemptFinding =
  | 'never_submitted'
  | 'cups_completed_printed'
  | 'cups_completed_partial'
  | 'cups_completed_blank'
  | 'cups_failed'
  | 'unknown';

export interface EvidenceParams {
  jobId: string;
  printerUuid: string;
  attempt: number;
  cupsJobId: string;
  cupsState: string;
}

export interface AttemptFindingInput {
  attempt: number;
  printerId: string | null;
  finding: AttemptFinding;
}

export interface OperatorOutcomeParams {
  jobId: string;
  outcome: Exclude<PhysicalOutcome, 'unknown'>;
  verifiedPages: number | null;
  method: string;
  reason: string;
  attemptFindings: AttemptFindingInput[];
  operatorId: string | null;
}

const FINAL = ['completed', 'failed', 'cancelled'];

interface QueueOutcomeRow {
  status: string;
  lease_count: number | null;
  physical_outcome: PhysicalOutcome;
  physical_verified_pages: number | null;
  total_pages: number | null;
}

interface AttemptRow {
  attempt: number;
  printer_id: string | null;
}

export class PhysicalOutcomeService {
  constructor(private readonly database: Database = db) {}

  /**
   * Printer evidence for one attempt the caller actually held. Rejects any
   * attempt that belongs to another printer, and any job the caller never held.
   * Does not affect assignment release.
   */
  async recordEvidence(
    params: EvidenceParams
  ): Promise<{ applied: boolean; physicalOutcome: PhysicalOutcome }> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');

      const queue = await client.query<{ physical_outcome: PhysicalOutcome }>(
        `SELECT physical_outcome FROM print_queue WHERE job_id = $1`,
        [params.jobId]
      );
      if (queue.rows.length === 0) {
        throw new AppError('Job not found in print queue', 404);
      }

      const mine = await client.query(
        `SELECT 1 FROM print_attempts WHERE job_id = $1 AND printer_id = $2 LIMIT 1`,
        [params.jobId, params.printerUuid]
      );
      if (mine.rows.length === 0) {
        throw new AppError('This job is not assigned to your printer', 403, 'JOB_NOT_ASSIGNED');
      }

      const attempt = await client.query<AttemptRow>(
        `SELECT attempt, printer_id FROM print_attempts WHERE job_id = $1 AND attempt = $2`,
        [params.jobId, params.attempt]
      );
      if (attempt.rows.length === 0) {
        throw new AppError('No such attempt for this job', 409, 'ATTEMPT_NOT_FOUND');
      }
      if (attempt.rows[0].printer_id !== params.printerUuid) {
        throw new AppError('That attempt belongs to another printer', 409, 'STALE_ATTEMPT');
      }

      const inserted = await client.query(
        `INSERT INTO print_physical_evidence
           (job_id, attempt, printer_id, cups_job_id, cups_state)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (job_id, attempt, printer_id, cups_job_id, cups_state) DO NOTHING`,
        [params.jobId, params.attempt, params.printerUuid, params.cupsJobId, params.cupsState]
      );

      await client.query('COMMIT');

      return {
        applied: (inserted.rowCount ?? 0) > 0,
        physicalOutcome: queue.rows[0].physical_outcome,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (!(error instanceof AppError)) {
        logger.error('Error recording physical evidence', { error, jobId: params.jobId });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Operator-verified outcome. Rules:
   *  - the job must be final;
   *  - every attempt must be accounted for, with its printer matching the record;
   *  - `not_printed` needs a verified count of 0 and no `unknown` attempt;
   *    a CUPS failure alone is not enough, because pages may already have come out;
   *  - `printed`, `partial` and `blank` need a count that matches the outcome, and
   *    at least one attempt that reached CUPS;
   *  - the first recorded outcome is final. The same one again is a no-op.
   */
  async recordOperatorOutcome(
    params: OperatorOutcomeParams
  ): Promise<{ applied: boolean; physicalOutcome: PhysicalOutcome; verifiedPages: number | null }> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');

      const queue = await client.query<QueueOutcomeRow>(
        `SELECT pq.status, pq.lease_count, pq.physical_outcome,
                pq.physical_verified_pages, pj.total_pages
           FROM print_queue pq
           JOIN print_jobs pj ON pj.id = pq.job_id
          WHERE pq.job_id = $1
          FOR UPDATE OF pq`,
        [params.jobId]
      );
      if (queue.rows.length === 0) {
        throw new AppError('Job not found in print queue', 404);
      }
      const row = queue.rows[0];

      if (!FINAL.includes(row.status)) {
        throw new AppError(
          'The job is still in progress; an outcome can be recorded once it is final',
          409,
          'JOB_STILL_ACTIVE'
        );
      }

      const attempts = await client.query<AttemptRow>(
        `SELECT attempt, printer_id FROM print_attempts WHERE job_id = $1`,
        [params.jobId]
      );
      const recorded = new Map(attempts.rows.map((a) => [a.attempt, a.printer_id]));
      const leaseCount = row.lease_count ?? 0;

      // Every finding must name an attempt that exists, and its printer must match.
      const findings = new Map<number, AttemptFinding>();
      for (const f of params.attemptFindings) {
        if (f.attempt > leaseCount) {
          throw new AppError(
            `Attempt ${f.attempt} does not exist for this job`,
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        if (findings.has(f.attempt)) {
          throw new AppError(
            `Attempt ${f.attempt} is listed more than once`,
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        // An attempt with no record (legacy history) must be given with no printer.
        const expectedPrinter = recorded.has(f.attempt) ? (recorded.get(f.attempt) ?? null) : null;
        if (f.printerId !== expectedPrinter) {
          throw new AppError(
            `printerId does not match the recorded holder of attempt ${f.attempt}`,
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        findings.set(f.attempt, f.finding);
      }

      const missing: number[] = [];
      for (let n = 1; n <= leaseCount; n++) {
        if (!findings.has(n)) missing.push(n);
      }
      if (missing.length > 0) {
        throw new AppError(
          `Attempts not yet accounted for: ${missing.join(', ')}`,
          409,
          'ATTEMPTS_UNRECONCILED'
        );
      }

      const total = row.total_pages ?? 0;
      const all = [...findings.values()];
      const verified = params.verifiedPages;

      if (params.outcome === 'not_printed') {
        if (all.includes('unknown')) {
          throw new AppError(
            'An attempt is still unknown; reconcile it before recording not_printed',
            409,
            'ATTEMPTS_UNRECONCILED'
          );
        }
        if (all.some((f) => f.startsWith('cups_completed'))) {
          throw new AppError(
            'An attempt CUPS reported as completed is blank or printed, not not_printed. Record blank or printed',
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        if (verified !== 0) {
          throw new AppError(
            'not_printed needs a verified page count of 0. A CUPS failure alone does not prove that no pages came out',
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
      } else {
        if (params.outcome === 'printed' && verified !== total) {
          throw new AppError(
            `printed needs a verified count of ${total}`,
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        if (params.outcome === 'partial' && !(verified! > 0 && verified! < total)) {
          throw new AppError(
            `partial needs a verified count above 0 and below ${total}`,
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
        if (params.outcome === 'blank' && verified !== 0) {
          throw new AppError('blank needs a verified count of 0', 400, 'PHYSICAL_OUTCOME_INVALID');
        }
        if (!all.some((f) => f !== 'never_submitted')) {
          throw new AppError(
            'Output needs at least one attempt that reached CUPS',
            400,
            'PHYSICAL_OUTCOME_INVALID'
          );
        }
      }

      if (row.physical_outcome !== 'unknown') {
        const same =
          row.physical_outcome === params.outcome && row.physical_verified_pages === verified;
        await client.query('COMMIT');
        if (same) {
          return {
            applied: false,
            physicalOutcome: row.physical_outcome,
            verifiedPages: row.physical_verified_pages,
          };
        }
        throw new AppError(
          `The job is already recorded as ${row.physical_outcome}`,
          409,
          'PHYSICAL_OUTCOME_CONFLICT'
        );
      }

      await client.query(
        `UPDATE print_queue SET
           physical_outcome = $2,
           physical_verified_pages = $3,
           physical_method = $4,
           physical_reason = $5,
           physical_recorded_by = $6,
           physical_recorded_at = NOW(),
           physical_attempt_findings = $7::jsonb,
           updated_at = NOW()
         WHERE job_id = $1`,
        [
          params.jobId,
          params.outcome,
          verified,
          params.method,
          params.reason,
          params.operatorId,
          JSON.stringify(params.attemptFindings),
        ]
      );

      await client.query('COMMIT');
      return { applied: true, physicalOutcome: params.outcome, verifiedPages: verified };
    } catch (error) {
      await client.query('ROLLBACK');
      if (!(error instanceof AppError)) {
        logger.error('Error recording operator outcome', { error, jobId: params.jobId });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** What an operator needs to reconcile a job: the attempts, the evidence and the current outcome. */
  async getForOperator(jobId: string) {
    const queue = await this.database.query<{
      status: string;
      lease_count: number | null;
      physical_outcome: PhysicalOutcome;
      physical_verified_pages: number | null;
      physical_method: string | null;
      physical_reason: string | null;
      physical_recorded_at: Date | null;
      physical_attempt_findings: unknown;
      total_pages: number | null;
    }>(
      `SELECT pq.status, pq.lease_count, pq.physical_outcome, pq.physical_verified_pages,
              pq.physical_method, pq.physical_reason, pq.physical_recorded_at,
              pq.physical_attempt_findings, pj.total_pages
         FROM print_queue pq
         JOIN print_jobs pj ON pj.id = pq.job_id
        WHERE pq.job_id = $1`,
      [jobId]
    );
    if (queue.rows.length === 0) {
      throw new AppError('Job not found in print queue', 404);
    }
    const row = queue.rows[0];

    const attempts = await this.database.query<{
      attempt: number;
      printer_id: string | null;
      source: string;
      assigned_at: Date;
    }>(
      `SELECT attempt, printer_id, source, assigned_at FROM print_attempts
        WHERE job_id = $1 ORDER BY attempt`,
      [jobId]
    );

    const evidence = await this.database.query<{
      attempt: number;
      printer_id: string;
      cups_job_id: string;
      cups_state: string;
      reported_at: Date;
    }>(
      `SELECT attempt, printer_id, cups_job_id, cups_state, reported_at
         FROM print_physical_evidence WHERE job_id = $1 ORDER BY reported_at, id`,
      [jobId]
    );

    const leaseCount = row.lease_count ?? 0;
    const recordedAttempts = new Set(attempts.rows.map((a) => a.attempt));
    const missingHistory: number[] = [];
    for (let n = 1; n <= leaseCount; n++) {
      if (!recordedAttempts.has(n)) missingHistory.push(n);
    }

    return {
      jobStatus: row.status,
      totalPages: row.total_pages ?? 0,
      attemptsComplete: missingHistory.length === 0,
      missingAttemptHistory: missingHistory,
      physicalOutcome: row.physical_outcome,
      verifiedPages: row.physical_verified_pages,
      method: row.physical_method,
      reason: row.physical_reason,
      recordedAt: row.physical_recorded_at,
      attemptFindings: row.physical_attempt_findings ?? null,
      attempts: attempts.rows.map((a) => ({
        attempt: a.attempt,
        printerId: a.printer_id,
        source: a.source,
        assignedAt: a.assigned_at,
      })),
      evidence: evidence.rows.map((e) => ({
        attempt: e.attempt,
        printerId: e.printer_id,
        cupsJobId: e.cups_job_id,
        cupsState: e.cups_state,
        reportedAt: e.reported_at,
      })),
    };
  }
}

export const physicalOutcomeService = new PhysicalOutcomeService();
