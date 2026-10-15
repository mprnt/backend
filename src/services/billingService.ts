import { Database, PoolClient, db } from '../config/database';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';
import { auditService } from './auditService';
import {
  ContractPhase,
  Period,
  addDays,
  addMonths,
  billablePeriodsDue,
  contractPhase,
  daysBetween,
  isOverdue,
  istDate,
  paidThrough,
  periodFor,
} from './billingSchedule';

/**
 * Model 1 billing: the hardware sale and the monthly software subscription.
 *
 * Money and dates are decided here and the database backs them up (migration
 * 022 refuses edits to frozen amounts, double payments and deletes). Every date
 * rule takes an explicit `now`, so a test can run a whole year of billing by
 * moving the clock, against the real database.
 */

export const MODEL_1 = 'integration';

export const PAYMENT_METHODS = ['bank_transfer', 'upi', 'cash', 'cheque', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Methods whose payment cannot be proven without the bank's or UPI's own reference. */
const REFERENCE_REQUIRED: ReadonlySet<PaymentMethod> = new Set(['bank_transfer', 'upi', 'cheque']);

/** Tolerance for clocks that disagree by a few seconds: "now" may be a moment ago. */
const PAST_TOLERANCE_MS = 60 * 1000;

type Queryable = Pick<PoolClient, 'query'>;

// ---------------------------------------------------------------------------
// Pure derivation, shared by the shop view, the super-admin view and the
// portfolio, so the three cannot disagree about what is owed.
// ---------------------------------------------------------------------------

export interface PlanSnapshot {
  hardwarePrice: number;
  monthlyPrice: number;
  freeMonths: number;
  graceDays: number;
}

export interface ChargeRecord {
  id: string;
  kind: 'hardware' | 'software';
  periodIndex: number;
  periodStart: string;
  periodEnd: string;
  amount: number;
  dueOn: string;
  status: 'due' | 'paid' | 'waived';
  settledOn: string | null;
  paymentMethod: PaymentMethod | null;
  paymentReference: string | null;
  settleNote: string | null;
  settledByEmail: string | null;
}

export interface ContractRecord {
  goLiveOn: string | null;
  soldOn: string;
  saleNote: string | null;
  goLiveNote: string | null;
  soldByEmail: string | null;
  goLiveByEmail: string | null;
  plan: PlanSnapshot;
}

export interface DerivedContract {
  phase: ContractPhase;
  goLiveOn: string | null;
  /** Last day of the free months, or null before go-live. */
  freeUntil: string | null;
  /** Last day covered by a payment or waiver, walking months in order. */
  paidThrough: string | null;
  /** What is owed right now, earliest first. */
  owed: Array<{ charge: ChargeRecord; overdue: boolean; daysOverdue: number }>;
  /** The next payment the partner must make, or the next upcoming month. */
  nextPayment: {
    amount: number;
    dueOn: string;
    periodIndex: number | null;
    kind: 'hardware' | 'software';
  } | null;
  hardware: ChargeRecord | null;
  charges: ChargeRecord[];
}

/**
 * Works out a contract's state from its frozen terms, its charges and today.
 * Nothing here is stored: overdue and phase always reflect the day they are read.
 */
export function deriveContract(
  contract: ContractRecord,
  charges: ChargeRecord[],
  today: string
): DerivedContract {
  const sorted = [...charges].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.periodIndex - b.periodIndex
  );
  const hardware = sorted.find((c) => c.kind === 'hardware') ?? null;
  const software = sorted.filter((c) => c.kind === 'software');
  const schedule = { goLiveOn: contract.goLiveOn ?? '', freeMonths: contract.plan.freeMonths };
  const goLive = contract.goLiveOn;

  // Owed means due and already due. A charge row dated after `today` (raised in
  // advance, or read as of an earlier day) is not owed yet.
  const owedCharges = software.filter((c) => c.status === 'due' && c.dueOn <= today);
  const owed = owedCharges
    .map((charge) => ({
      charge,
      overdue: isOverdue(charge.dueOn, contract.plan.graceDays, today),
      daysOverdue: Math.max(0, daysBetween(addDays(charge.dueOn, contract.plan.graceDays), today)),
    }))
    .sort((a, b) => a.charge.dueOn.localeCompare(b.charge.dueOn));

  const covered = new Set(software.filter((c) => c.status !== 'due').map((c) => c.periodIndex));

  const phase = contractPhase({
    hardwareSettled: hardware !== null && hardware.status !== 'due',
    goLiveOn: goLive,
    freeMonths: contract.plan.freeMonths,
    today,
    owed: owedCharges.map((c) => ({ dueOn: c.dueOn })),
    graceDays: contract.plan.graceDays,
  });

  let nextPayment: DerivedContract['nextPayment'] = null;
  if (hardware && hardware.status === 'due') {
    nextPayment = {
      amount: hardware.amount,
      dueOn: hardware.dueOn,
      periodIndex: null,
      kind: 'hardware',
    };
  } else if (owed.length > 0) {
    const first = owed[0].charge;
    nextPayment = {
      amount: first.amount,
      dueOn: first.dueOn,
      periodIndex: first.periodIndex,
      kind: 'software',
    };
  } else if (goLive && contract.plan.monthlyPrice > 0) {
    // The next month nobody has settled yet. Its charge row may not exist yet.
    let index = contract.plan.freeMonths + 1;
    while (covered.has(index)) index++;
    nextPayment = {
      amount: contract.plan.monthlyPrice,
      dueOn: periodFor(schedule, index).start,
      periodIndex: index,
      kind: 'software',
    };
  }

  return {
    phase,
    goLiveOn: goLive,
    freeUntil:
      goLive && contract.plan.freeMonths > 0
        ? addDays(addMonths(goLive, contract.plan.freeMonths), -1)
        : null,
    paidThrough: goLive ? paidThrough(schedule, covered) : null,
    owed,
    nextPayment,
    hardware,
    charges: sorted,
  };
}

/**
 * A contract as one viewer may see it. The owed/hardware/charges detail is only
 * present for a super admin, so a partner's view never holds internal rows at all.
 */
export type ContractView = Pick<
  DerivedContract,
  'phase' | 'goLiveOn' | 'freeUntil' | 'paidThrough' | 'nextPayment'
> & {
  invoices: Invoice[];
  terms: PlanSnapshot;
  soldOn: string;
  saleNote: string | null;
  goLiveNote: string | null;
  soldByEmail: string | null;
  goLiveByEmail: string | null;
  owed?: DerivedContract['owed'];
  hardware?: ChargeRecord | null;
  charges?: ChargeRecord[];
};

export interface ShopContractView {
  phase: ContractPhase;
  soldOn: string;
  goLiveOn: string | null;
  freeUntil: string | null;
  paidThrough: string | null;
  nextPayment: { amount: number; dueOn: string; kind: 'hardware' | 'software' } | null;
  terms: { hardwarePrice: number; monthlyPrice: number; freeMonths: number };
  invoices: Invoice[];
  gstInclusive: true;
}

/**
 * The partner's own view of its contract, built field by field. Anything not
 * listed here never leaves the server: the internal notes, the people who set
 * the terms, the payment references, the grace policy and the raw charge rows.
 */
export function toShopContract(c: ContractView): ShopContractView {
  return {
    phase: c.phase,
    soldOn: c.soldOn,
    goLiveOn: c.goLiveOn,
    freeUntil: c.freeUntil,
    paidThrough: c.paidThrough,
    nextPayment: c.nextPayment
      ? { amount: c.nextPayment.amount, dueOn: c.nextPayment.dueOn, kind: c.nextPayment.kind }
      : null,
    terms: {
      hardwarePrice: c.terms.hardwarePrice,
      monthlyPrice: c.terms.monthlyPrice,
      freeMonths: c.terms.freeMonths,
    },
    invoices: c.invoices.map((i) => ({
      id: i.id,
      kind: i.kind,
      label: i.label,
      periodStart: i.periodStart,
      periodEnd: i.periodEnd,
      amount: i.amount,
      dueOn: i.dueOn,
      status: i.status,
      paidOn: i.paidOn,
    })),
    gstInclusive: true,
  };
}

// ---------------------------------------------------------------------------
// Input checks shared by the service and the controller.
// ---------------------------------------------------------------------------

function isCalendarDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    (() => {
      try {
        addMonths(value, 0);
        return true;
      } catch {
        return false;
      }
    })()
  );
}

function assertNotPast(effectiveFrom: Date, now: Date): void {
  if (effectiveFrom.getTime() < now.getTime() - PAST_TOLERANCE_MS) {
    throw new AppError('A billing price cannot take effect in the past', 400, 'EFFECTIVE_IN_PAST');
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** Where a change came from, for the audit trail. Never used to decide anything. */
export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface PlanInput {
  request?: RequestMeta;
  hardwarePrice: number;
  monthlyPrice: number;
  freeMonths: number;
  graceDays: number;
  effectiveFrom: Date | null;
  note: string;
  actorId: string;
}

export interface SaleInput {
  request?: RequestMeta;
  organizationId: string;
  note: string;
  actorId: string;
  now?: Date;
}

export interface GoLiveInput {
  request?: RequestMeta;
  organizationId: string;
  goLiveOn: string;
  note: string;
  actorId: string;
  now?: Date;
}

export interface SettleInput {
  request?: RequestMeta;
  chargeId: string;
  action: 'paid' | 'waive';
  method?: PaymentMethod;
  reference?: string | null;
  note?: string | null;
  actorId: string;
  now?: Date;
}

export class BillingService {
  constructor(private database: Database = db) {}

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The Model 1 price in force now. Refuses to sell rather than guess one. */
  async getActivePlan(
    client: Queryable,
    now: Date = new Date()
  ): Promise<PlanSnapshot & { id: string }> {
    const result = await client.query<{
      id: string;
      hardware_price: string;
      monthly_price: string;
      free_months: number;
      grace_days: number;
    }>(
      `SELECT id, hardware_price, monthly_price, free_months, grace_days
         FROM billing_plan_terms
        WHERE business_model = $1 AND effective_from <= $2
        ORDER BY effective_from DESC, created_at DESC
        LIMIT 1`,
      [MODEL_1, now]
    );
    if (result.rows.length === 0) {
      throw new AppError(
        'No Model 1 price is set yet. Set the price before recording a sale.',
        409,
        'NO_PLAN'
      );
    }
    const r = result.rows[0];
    return {
      id: r.id,
      hardwarePrice: Number(r.hardware_price),
      monthlyPrice: Number(r.monthly_price),
      freeMonths: r.free_months,
      graceDays: r.grace_days,
    };
  }

  /** Every published Model 1 price, newest first, with who published it. */
  async listPlans(limit = 50): Promise<
    Array<{
      id: string;
      hardwarePrice: number;
      monthlyPrice: number;
      freeMonths: number;
      graceDays: number;
      effectiveFrom: string;
      note: string;
      createdByEmail: string | null;
      createdAt: string;
    }>
  > {
    const result = await this.database.query<{
      id: string;
      hardware_price: string;
      monthly_price: string;
      free_months: number;
      grace_days: number;
      effective_from: Date;
      note: string;
      created_by_email: string | null;
      created_at: Date;
    }>(
      `SELECT t.id, t.hardware_price, t.monthly_price, t.free_months, t.grace_days,
              t.effective_from, t.note, a.email AS created_by_email, t.created_at
         FROM billing_plan_terms t
         LEFT JOIN admin_users a ON a.id = t.created_by
        WHERE t.business_model = $1
        ORDER BY t.effective_from DESC, t.created_at DESC
        LIMIT $2`,
      [MODEL_1, limit]
    );
    return result.rows.map((r) => ({
      id: r.id,
      hardwarePrice: Number(r.hardware_price),
      monthlyPrice: Number(r.monthly_price),
      freeMonths: r.free_months,
      graceDays: r.grace_days,
      effectiveFrom: new Date(r.effective_from).toISOString(),
      note: r.note,
      createdByEmail: r.created_by_email,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  /** Publishes new Model 1 prices. Existing contracts keep the prices they were sold on. */
  async setPlan(
    input: PlanInput,
    now: Date = new Date()
  ): Promise<{ id: string; effectiveFrom: Date }> {
    const effectiveFrom = input.effectiveFrom ?? now;
    assertNotPast(effectiveFrom, now);
    return this.tx(async (client) => {
      const result = await client.query<{ id: string; effective_from: Date }>(
        `INSERT INTO billing_plan_terms (
           business_model, hardware_price, monthly_price, free_months, grace_days,
           effective_from, note, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, effective_from`,
        [
          MODEL_1,
          input.hardwarePrice,
          input.monthlyPrice,
          input.freeMonths,
          input.graceDays,
          effectiveFrom,
          input.note.trim(),
          input.actorId,
        ]
      );
      const id = result.rows[0].id;
      await auditService.record(
        {
          actorId: input.actorId,
          actorScope: 'platform',
          action: 'billing.plan_set',
          resourceType: 'billing_plan_term',
          resourceId: id,
          details: {
            hardwarePrice: input.hardwarePrice,
            monthlyPrice: input.monthlyPrice,
            freeMonths: input.freeMonths,
            graceDays: input.graceDays,
            effectiveFrom: result.rows[0].effective_from,
            note: input.note.trim(),
          },
          ...input.request,
        },
        client
      );
      return { id, effectiveFrom: result.rows[0].effective_from };
    });
  }

  /**
   * Records the hardware sale. Copies the current prices onto the contract and
   * raises the hardware charge. One contract per partner.
   */
  async recordSale(input: SaleInput): Promise<{ contractId: string; chargeId: string }> {
    const now = input.now ?? new Date();
    return this.tx(async (client) => {
      const org = await client.query<{ business_model: string | null }>(
        `SELECT business_model FROM organizations
          WHERE id = $1 AND deleted_at IS NULL
          FOR UPDATE`,
        [input.organizationId]
      );
      if (org.rows.length === 0) throw new AppError('Partner not found', 404);
      if (org.rows[0].business_model !== MODEL_1) {
        throw new AppError(
          'A hardware sale applies only to partners on Model 1. Change the partner’s model first.',
          409,
          'NOT_MODEL_1'
        );
      }

      const existing = await client.query(
        `SELECT 1 FROM partner_contracts WHERE organization_id = $1`,
        [input.organizationId]
      );
      if (existing.rows.length > 0) {
        throw new AppError('This partner already has a Model 1 contract', 409, 'CONTRACT_EXISTS');
      }

      const plan = await this.getActivePlan(client, now);
      const soldOn = istDate(now);

      let contractId: string;
      try {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO partner_contracts (
             organization_id, plan_term_id, business_model, hardware_price, monthly_price,
             free_months, grace_days, sold_at, sold_by, sale_note
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            input.organizationId,
            plan.id,
            MODEL_1,
            plan.hardwarePrice,
            plan.monthlyPrice,
            plan.freeMonths,
            plan.graceDays,
            now,
            input.actorId,
            input.note.trim(),
          ]
        );
        contractId = inserted.rows[0].id;
      } catch (error) {
        // A concurrent sale to the same partner loses on the unique key.
        if ((error as { code?: string }).code === '23505') {
          throw new AppError('This partner already has a Model 1 contract', 409, 'CONTRACT_EXISTS');
        }
        throw error;
      }

      const charge = await client.query<{ id: string }>(
        `INSERT INTO billing_charges (
           contract_id, kind, period_index, period_start, period_end, amount, due_on
         ) VALUES ($1, 'hardware', 0, $2, $2, $3, $2)
         RETURNING id`,
        [contractId, soldOn, plan.hardwarePrice]
      );

      await auditService.record(
        {
          actorId: input.actorId,
          actorScope: 'platform',
          action: 'billing.sale_recorded',
          resourceType: 'partner_contract',
          resourceId: contractId,
          organizationId: input.organizationId,
          details: {
            note: input.note.trim(),
            chargeId: charge.rows[0].id,
            hardwarePrice: plan.hardwarePrice,
            monthlyPrice: plan.monthlyPrice,
            freeMonths: plan.freeMonths,
            graceDays: plan.graceDays,
            planTermId: plan.id,
          },
          ...input.request,
        },
        client
      );

      return { contractId, chargeId: charge.rows[0].id };
    });
  }

  /**
   * Starts the clock. Refused until the hardware is paid or waived, and the go-live
   * day must fall between the sale and today: a future go-live would bill for
   * months nobody has used, and a backdated one would invent overdue charges.
   */
  async markLive(input: GoLiveInput): Promise<{ goLiveOn: string }> {
    const now = input.now ?? new Date();
    if (!isCalendarDate(input.goLiveOn)) {
      throw new AppError('Go-live must be a calendar date (YYYY-MM-DD)', 400, 'BAD_DATE');
    }
    const today = istDate(now);

    return this.tx(async (client) => {
      const row = await client.query<{
        contract_id: string;
        go_live_on: string | null;
        sold_on: string;
        business_model: string | null;
        hw_status: string | null;
      }>(
        `SELECT c.id AS contract_id,
                to_char(c.go_live_on, 'YYYY-MM-DD') AS go_live_on,
                to_char(c.sold_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS sold_on,
                o.business_model,
                h.status AS hw_status
           FROM partner_contracts c
           JOIN organizations o ON o.id = c.organization_id
           LEFT JOIN billing_charges h ON h.contract_id = c.id AND h.kind = 'hardware'
          WHERE c.organization_id = $1 AND o.deleted_at IS NULL
          FOR UPDATE OF c`,
        [input.organizationId]
      );
      if (row.rows.length === 0)
        throw new AppError('This partner has no Model 1 contract yet', 404, 'NO_CONTRACT');
      const c = row.rows[0];

      if (c.go_live_on) throw new AppError('This partner is already live', 409, 'ALREADY_LIVE');
      if (c.business_model !== MODEL_1) {
        throw new AppError(
          'The partner is no longer on Model 1, so it cannot go live under this contract',
          409,
          'NOT_MODEL_1'
        );
      }
      if (c.hw_status === 'due' || c.hw_status === null) {
        throw new AppError(
          'The hardware must be paid or waived before go-live',
          409,
          'HARDWARE_UNSETTLED'
        );
      }
      if (input.goLiveOn > today) {
        throw new AppError('Go-live cannot be in the future', 400, 'GO_LIVE_IN_FUTURE');
      }
      if (input.goLiveOn < c.sold_on) {
        throw new AppError('Go-live cannot be before the sale', 400, 'GO_LIVE_BEFORE_SALE');
      }

      await client.query(
        `UPDATE partner_contracts
            SET go_live_on = $2,
                go_live_recorded_at = $3,
                go_live_recorded_by = $4,
                go_live_note = $5
          WHERE id = $1`,
        [c.contract_id, input.goLiveOn, now, input.actorId, input.note.trim()]
      );
      await auditService.record(
        {
          actorId: input.actorId,
          actorScope: 'platform',
          action: 'billing.went_live',
          resourceType: 'partner_contract',
          resourceId: c.contract_id,
          organizationId: input.organizationId,
          details: { goLiveOn: input.goLiveOn, note: input.note.trim() },
          ...input.request,
        },
        client
      );
      return { goLiveOn: input.goLiveOn };
    });
  }

  /**
   * Raises every software charge whose month has begun, for every live contract.
   * Idempotent: the unique key on (contract, kind, period) means a second run
   * creates nothing new. Reads its prices from the contract, never the plan.
   */
  async raiseDueCharges(
    now: Date = new Date()
  ): Promise<{ created: number; contracts: number; skipped: string[] }> {
    const today = istDate(now);
    const live = await this.database.query<{ id: string }>(
      `SELECT c.id FROM partner_contracts c
        WHERE c.go_live_on IS NOT NULL
        ORDER BY c.go_live_on, c.id`
    );

    let created = 0;
    const skipped: string[] = [];
    for (const { id } of live.rows) {
      const outcome = await this.tx(async (client) => {
        const locked = await client.query<{
          go_live_on: string;
          free_months: number;
          monthly_price: string;
          org_model: string | null;
          org_id: string;
        }>(
          `SELECT to_char(c.go_live_on, 'YYYY-MM-DD') AS go_live_on,
                  c.free_months, c.monthly_price, o.business_model AS org_model, c.organization_id AS org_id
             FROM partner_contracts c
             JOIN organizations o ON o.id = c.organization_id
            WHERE c.id = $1 AND o.deleted_at IS NULL
            FOR UPDATE OF c`,
          [id]
        );
        if (locked.rows.length === 0) return { created: 0, skip: 'deleted partner' };
        const c = locked.rows[0];

        // A partner that has since moved off Model 1 is not billed under this contract.
        if (c.org_model !== MODEL_1)
          return { created: 0, skip: `model is now ${c.org_model ?? 'not set'}` };
        // A free-forever plan has nothing to raise.
        if (Number(c.monthly_price) <= 0) return { created: 0, skip: null };

        const periods: Period[] = billablePeriodsDue(
          { goLiveOn: c.go_live_on, freeMonths: c.free_months },
          today
        );
        let inserted = 0;
        for (const period of periods) {
          const row = await client.query(
            `INSERT INTO billing_charges (
               contract_id, kind, period_index, period_start, period_end, amount, due_on
             ) VALUES ($1, 'software', $2, $3, $4, $5, $3)
             ON CONFLICT (contract_id, kind, period_index) DO NOTHING
             RETURNING id`,
            [id, period.index, period.start, period.end, Number(c.monthly_price)]
          );
          inserted += row.rowCount ?? 0;
        }
        if (inserted > 0) {
          await auditService.record(
            {
              actorId: null,
              actorScope: 'platform',
              action: 'billing.charges_raised',
              resourceType: 'partner_contract',
              resourceId: id,
              organizationId: c.org_id,
              details: { created: inserted, today },
            },
            client
          );
        }
        return { created: inserted, skip: null };
      });

      created += outcome.created;
      if (outcome.skip) {
        skipped.push(outcome.skip);
        logger.warn('Billing: contract skipped this run', { contractId: id, reason: outcome.skip });
      }
    }

    return { created, contracts: live.rows.length, skipped };
  }

  /**
   * Records a payment or a waiver against one charge. A charge settles once,
   * from due. Locks the row, so two people clicking at once cannot both win.
   */
  async settleCharge(input: SettleInput): Promise<{ chargeId: string; status: 'paid' | 'waived' }> {
    const now = input.now ?? new Date();
    const note = input.note?.trim() || null;

    if (input.action === 'paid') {
      if (!input.method || !(PAYMENT_METHODS as readonly string[]).includes(input.method)) {
        throw new AppError('Choose how the payment was made', 400, 'BAD_METHOD');
      }
      const reference = input.reference?.trim() || null;
      if (REFERENCE_REQUIRED.has(input.method) && (!reference || reference.length < 3)) {
        throw new AppError(
          'Bank transfers, UPI and cheques need the reference that proves the payment',
          400,
          'REFERENCE_REQUIRED'
        );
      }
    } else {
      if (!note || note.length < 3) {
        throw new AppError(
          'A waiver needs a reason of at least 3 characters',
          400,
          'REASON_REQUIRED'
        );
      }
    }

    return this.tx(async (client) => {
      const charge = await client.query<{
        status: string;
        kind: string;
        amount: string;
        organization_id: string;
      }>(
        `SELECT ch.status, ch.kind, ch.amount, c.organization_id
           FROM billing_charges ch
           JOIN partner_contracts c ON c.id = ch.contract_id
          WHERE ch.id = $1
          FOR UPDATE OF ch`,
        [input.chargeId]
      );
      if (charge.rows.length === 0) throw new AppError('Charge not found', 404);
      const row = charge.rows[0];
      if (row.status !== 'due') {
        throw new AppError(`This charge is already ${row.status}`, 409, 'ALREADY_SETTLED');
      }

      if (input.action === 'paid') {
        await client.query(
          `UPDATE billing_charges
              SET status = 'paid', settled_at = $2, settled_by = $3,
                  payment_method = $4, payment_reference = $5, settle_note = $6
            WHERE id = $1`,
          [input.chargeId, now, input.actorId, input.method, input.reference?.trim() || null, note]
        );
      } else {
        await client.query(
          `UPDATE billing_charges
              SET status = 'waived', settled_at = $2, settled_by = $3, settle_note = $4
            WHERE id = $1`,
          [input.chargeId, now, input.actorId, note]
        );
      }

      // The reference is the proof of payment: it lives on the charge, not in the log.
      await auditService.record(
        {
          actorId: input.actorId,
          actorScope: 'platform',
          action: input.action === 'paid' ? 'billing.charge_paid' : 'billing.charge_waived',
          resourceType: 'billing_charge',
          resourceId: input.chargeId,
          organizationId: row.organization_id,
          details: {
            kind: row.kind,
            amount: Number(row.amount),
            method: input.method ?? null,
            hasReference: Boolean(input.reference?.trim()),
            note,
          },
          ...input.request,
        },
        client
      );
      return {
        chargeId: input.chargeId,
        status: input.action === 'paid' ? ('paid' as const) : ('waived' as const),
      };
    });
  }

  /** The contract for one partner, derived for the given viewer. Null when there is no contract. */
  async getContract(
    organizationId: string,
    options: { includeInternal: boolean; now?: Date }
  ): Promise<{
    organization: { name: string; businessModel: string | null };
    contract: ContractView | null;
  }> {
    const now = options.now ?? new Date();
    const org = await this.database.query<{ name: string; business_model: string | null }>(
      `SELECT name, business_model FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [organizationId]
    );
    if (org.rows.length === 0) throw new AppError('Partner not found', 404);

    const row = await this.database.query<ContractRow>(
      `SELECT ${CONTRACT_COLUMNS} ${CONTRACT_FROM} WHERE c.organization_id = $1`,
      [organizationId]
    );
    if (row.rows.length === 0) {
      return {
        organization: { name: org.rows[0].name, businessModel: org.rows[0].business_model },
        contract: null,
      };
    }

    const { contract, charges } = await this.loadContract(row.rows[0]);
    const today = istDate(now);
    const derived = deriveContract(contract, charges, today);

    const invoices = charges.map((c) =>
      toInvoice(c, contract.plan.graceDays, today, options.includeInternal)
    );

    const view: ContractView = {
      phase: derived.phase,
      goLiveOn: derived.goLiveOn,
      freeUntil: derived.freeUntil,
      paidThrough: derived.paidThrough,
      nextPayment: derived.nextPayment,
      invoices,
      terms: contract.plan,
      soldOn: contract.soldOn,
      saleNote: options.includeInternal ? contract.saleNote : null,
      goLiveNote: options.includeInternal ? contract.goLiveNote : null,
      soldByEmail: options.includeInternal ? contract.soldByEmail : null,
      goLiveByEmail: options.includeInternal ? contract.goLiveByEmail : null,
    };
    if (options.includeInternal) {
      view.owed = derived.owed;
      view.hardware = derived.hardware;
      view.charges = derived.charges;
    }

    return {
      organization: { name: org.rows[0].name, businessModel: org.rows[0].business_model },
      contract: view,
    };
  }

  /** Loads contracts and their charges. Charges come in one query for all contracts, not one each. */
  private async loadContracts(
    rows: ContractRow[]
  ): Promise<Map<string, { contract: ContractRecord; charges: ChargeRecord[] }>> {
    const out = new Map<string, { contract: ContractRecord; charges: ChargeRecord[] }>();
    if (rows.length === 0) return out;

    const charges = await this.database.query<ChargeRow & { contract_id: string }>(
      `SELECT ch.contract_id, ch.id, ch.kind, ch.period_index,
              to_char(ch.period_start, 'YYYY-MM-DD') AS period_start,
              to_char(ch.period_end, 'YYYY-MM-DD') AS period_end,
              ch.amount, to_char(ch.due_on, 'YYYY-MM-DD') AS due_on,
              ch.status,
              to_char(ch.settled_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS settled_on,
              ch.payment_method, ch.payment_reference, ch.settle_note,
              a.email AS settled_by_email
         FROM billing_charges ch
         LEFT JOIN admin_users a ON a.id = ch.settled_by
        WHERE ch.contract_id = ANY($1::uuid[])
        ORDER BY ch.contract_id, ch.kind, ch.period_index`,
      [rows.map((r) => r.id)]
    );

    const byContract = new Map<string, ChargeRecord[]>();
    for (const ch of charges.rows) {
      byContract.set(ch.contract_id, [...(byContract.get(ch.contract_id) ?? []), toCharge(ch)]);
    }

    for (const r of rows) {
      out.set(r.id, {
        contract: {
          goLiveOn: r.go_live_on,
          soldOn: r.sold_on,
          saleNote: r.sale_note,
          goLiveNote: r.go_live_note,
          soldByEmail: r.sold_by_email,
          goLiveByEmail: r.go_live_by_email,
          plan: {
            hardwarePrice: Number(r.hardware_price),
            monthlyPrice: Number(r.monthly_price),
            freeMonths: r.free_months,
            graceDays: r.grace_days,
          },
        },
        charges: byContract.get(r.id) ?? [],
      });
    }
    return out;
  }

  private async loadContract(
    row: ContractRow
  ): Promise<{ contract: ContractRecord; charges: ChargeRecord[] }> {
    const loaded = await this.loadContracts([row]);
    return loaded.get(row.id)!;
  }

  /** Every contract, derived for today, for the sales view. */
  async listContracts(now: Date = new Date()): Promise<{
    rows: Array<{
      organizationId: string;
      organizationName: string;
      phase: ContractPhase;
      hardwareStatus: string;
      hardwarePrice: number;
      goLiveOn: string | null;
      freeUntil: string | null;
      paidThrough: string | null;
      nextPayment: DerivedContract['nextPayment'];
      overdueCount: number;
      overdueAmount: number;
      soldOn: string;
      monthlyPrice: number;
    }>;
    totals: Record<string, number>;
  }> {
    const today = istDate(now);
    const list = await this.database.query<ContractRow & { organization_name: string }>(
      `SELECT o.name AS organization_name, ${CONTRACT_COLUMNS} ${CONTRACT_FROM} ORDER BY c.sold_at DESC`
    );
    const loaded = await this.loadContracts(list.rows);

    const totals: Record<string, number> = {
      contracts: 0,
      awaiting_hardware: 0,
      not_live: 0,
      free: 0,
      active: 0,
      payment_due: 0,
      overdue: 0,
      hardware_collected: 0,
      software_overdue_amount: 0,
    };

    const rows = list.rows.map((r) => {
      const { contract, charges } = loaded.get(r.id)!;
      const derived = deriveContract(contract, charges, today);
      const overdue = derived.owed.filter((o) => o.overdue);
      const hardwarePaid = derived.hardware !== null && derived.hardware.status !== 'due';

      totals.contracts++;
      totals[derived.phase]++;
      if (hardwarePaid) totals.hardware_collected += derived.hardware!.amount;
      totals.software_overdue_amount += overdue.reduce((sum, o) => sum + o.charge.amount, 0);

      return {
        organizationId: r.organization_id,
        organizationName: r.organization_name,
        phase: derived.phase,
        hardwareStatus: derived.hardware?.status ?? 'missing',
        hardwarePrice: contract.plan.hardwarePrice,
        goLiveOn: derived.goLiveOn,
        freeUntil: derived.freeUntil,
        paidThrough: derived.paidThrough,
        nextPayment: derived.nextPayment,
        overdueCount: overdue.length,
        overdueAmount: overdue.reduce((sum, o) => sum + o.charge.amount, 0),
        soldOn: contract.soldOn,
        monthlyPrice: contract.plan.monthlyPrice,
      };
    });

    return { rows, totals };
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface ContractRow {
  id: string;
  organization_id: string;
  go_live_on: string | null;
  sold_on: string;
  sale_note: string | null;
  go_live_note: string | null;
  sold_by_email: string | null;
  go_live_by_email: string | null;
  hardware_price: string;
  monthly_price: string;
  free_months: number;
  grace_days: number;
}

const CONTRACT_COLUMNS = `
  c.id, c.organization_id,
  to_char(c.go_live_on, 'YYYY-MM-DD') AS go_live_on,
  to_char(c.sold_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS sold_on,
  c.sale_note, c.go_live_note,
  sold.email AS sold_by_email,
  live.email AS go_live_by_email,
  c.hardware_price, c.monthly_price, c.free_months, c.grace_days`;

const CONTRACT_FROM = `
  FROM partner_contracts c
  JOIN organizations o ON o.id = c.organization_id
  LEFT JOIN admin_users sold ON sold.id = c.sold_by
  LEFT JOIN admin_users live ON live.id = c.go_live_recorded_by`;

interface ChargeRow {
  id: string;
  kind: 'hardware' | 'software';
  period_index: number;
  period_start: string;
  period_end: string;
  amount: string;
  due_on: string;
  status: 'due' | 'paid' | 'waived';
  settled_on: string | null;
  payment_method: PaymentMethod | null;
  payment_reference: string | null;
  settle_note: string | null;
  settled_by_email: string | null;
}

function toCharge(r: ChargeRow): ChargeRecord {
  return {
    id: r.id,
    kind: r.kind,
    periodIndex: r.period_index,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    amount: Number(r.amount),
    dueOn: r.due_on,
    status: r.status,
    settledOn: r.settled_on,
    paymentMethod: r.payment_method,
    paymentReference: r.payment_reference,
    settleNote: r.settle_note,
    settledByEmail: r.settled_by_email,
  };
}

export interface Invoice {
  id: string;
  kind: 'hardware' | 'software';
  label: string;
  periodStart: string;
  periodEnd: string;
  amount: number;
  dueOn: string;
  /** Display status: 'due', 'overdue', 'paid' or 'waived'. */
  status: 'due' | 'overdue' | 'paid' | 'waived';
  paidOn: string | null;
  /** Only sent to a super admin. */
  paymentMethod?: PaymentMethod | null;
  paymentReference?: string | null;
  settleNote?: string | null;
  settledByEmail?: string | null;
}

/** Plain-language label for an invoice line. Hardware first, then the month it covers. */
export function invoiceLabel(c: ChargeRecord): string {
  if (c.kind === 'hardware') return 'Printer integration kit';
  const month = new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(`${c.periodStart}T12:00:00+05:30`));
  return `Software, ${month}`;
}

export function toInvoice(
  c: ChargeRecord,
  graceDays: number,
  today: string,
  includeInternal: boolean
): Invoice {
  const overdue = c.status === 'due' && isOverdue(c.dueOn, graceDays, today);
  const invoice: Invoice = {
    id: c.id,
    kind: c.kind,
    label: invoiceLabel(c),
    periodStart: c.periodStart,
    periodEnd: c.periodEnd,
    amount: c.amount,
    dueOn: c.dueOn,
    status: overdue ? 'overdue' : c.status,
    paidOn: c.status === 'paid' ? c.settledOn : null,
  };
  if (includeInternal) {
    invoice.paymentMethod = c.paymentMethod;
    invoice.paymentReference = c.paymentReference;
    invoice.settleNote = c.settleNote;
    invoice.settledByEmail = c.settledByEmail;
  }
  return invoice;
}

export const billingService = new BillingService();
