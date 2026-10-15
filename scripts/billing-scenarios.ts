/* eslint-disable no-console */
/**
 * Model 1 billing: every scenario, run against the real local database with a
 * simulated clock. Each run creates fresh partners, so it can be repeated.
 *
 *   npx ts-node scripts/billing-scenarios.ts
 *
 * Refuses to run against a database that is not on this machine.
 */
import { db } from '../src/config/database';
import env from '../src/config/environment';
import { AppError } from '../src/middleware/errorHandler';
import {
  billingService,
  deriveContract,
  toShopContract,
  ContractView,
  toInvoice,
} from '../src/services/billingService';
import { addMonths, istDate } from '../src/services/billingSchedule';

const url = env.database.url ?? '';
const LOCAL = /@(localhost|127\.0\.0\.1|\[::1\]|::1)[:/]/.test(url) || url === '';
if (!LOCAL) {
  console.error('Refusing to run: the database is not on this machine.');
  process.exit(2);
}

type Row = Record<string, unknown>;
const ids: Record<string, string> = {};
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail });
}

/** A moment in India time, from 'YYYY-MM-DDTHH:MM'. */
const at = (s: string) => new Date(`${s}:00+05:30`);

async function expectCode(name: string, fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    check(name, false, 'accepted, but should have been refused');
  } catch (error) {
    const got = error instanceof AppError ? error.code : String(error);
    check(name, got === code, got === code ? `refused: ${code}` : `refused with ${got}`);
  }
}

async function rows(sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await db.query(sql, params)).rows as Row[];
}

async function admin(): Promise<string> {
  const r = await rows(
    `SELECT id FROM admin_users WHERE email = 'qa-super@mprnt.test' AND is_active`
  );
  if (r.length === 0)
    throw new Error('The qa-super@mprnt.test account is needed to act as the platform');
  return r[0].id as string;
}

async function partner(label: string, model = 'integration'): Promise<string> {
  const slug = `m1-${label.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const r = await rows(
    `INSERT INTO organizations (name, slug, business_model) VALUES ($1, $2, $3) RETURNING id`,
    [`TEST billing ${label}`, slug, model]
  );
  return r[0].id as string;
}

async function charges(orgId: string): Promise<Row[]> {
  return rows(
    `SELECT ch.kind, ch.period_index, ch.status, ch.amount::float8 AS amount,
            to_char(ch.period_start,'YYYY-MM-DD') AS period_start,
            to_char(ch.period_end,'YYYY-MM-DD') AS period_end,
            to_char(ch.due_on,'YYYY-MM-DD') AS due_on,
            ch.payment_method, ch.payment_reference
       FROM billing_charges ch JOIN partner_contracts c ON c.id = ch.contract_id
      WHERE c.organization_id = $1
      ORDER BY ch.kind, ch.period_index`,
    [orgId]
  );
}

async function contract(orgId: string): Promise<Row | null> {
  const r = await rows(
    `SELECT monthly_price::float8 AS monthly_price, hardware_price::float8 AS hardware_price,
            free_months, grace_days, to_char(go_live_on,'YYYY-MM-DD') AS go_live_on
       FROM partner_contracts WHERE organization_id = $1`,
    [orgId]
  );
  return r[0] ?? null;
}

async function view(
  orgId: string,
  now: Date,
  includeInternal = true
): Promise<ContractView | null> {
  const v = await billingService.getContract(orgId, { includeInternal, now });
  return v.contract;
}

async function main() {
  const ADMIN = await admin();

  // Baseline plan, in force from 1 Jan 2026. Later scenarios publish their own.
  await billingService.setPlan(
    {
      hardwarePrice: 18999,
      monthlyPrice: 499,
      freeMonths: 1,
      graceDays: 5,
      effectiveFrom: at('2026-01-01T00:00'),
      note: 'Scenario baseline',
      actorId: ADMIN,
    },
    at('2026-01-01T00:00')
  );

  // ----- A. The happy path, month by month -----------------------------------
  {
    const org = await partner('A');
    ids.A = org;
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Sold at counter',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    check('A1 sale creates a contract and a hardware charge', !!sale.contractId && !!sale.chargeId);
    const ch = await charges(org);
    check(
      'A2 hardware is due on the sale day, in India time',
      ch.length === 1 &&
        ch[0].kind === 'hardware' &&
        ch[0].status === 'due' &&
        ch[0].due_on === '2026-09-25' &&
        Number(ch[0].amount) === 18999,
      JSON.stringify(ch[0])
    );

    await expectCode(
      'A3 go-live refused while hardware unpaid',
      () =>
        billingService.markLive({
          organizationId: org,
          goLiveOn: '2026-09-26',
          note: 'too early',
          actorId: ADMIN,
          now: at('2026-09-26T09:00'),
        }),
      'HARDWARE_UNSETTLED'
    );

    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'upi',
      reference: 'UTR-A1',
      actorId: ADMIN,
      now: at('2026-09-26T11:00'),
    });
    await expectCode(
      'A4 go-live refused for a future date',
      () =>
        billingService.markLive({
          organizationId: org,
          goLiveOn: '2026-10-02',
          note: 'future',
          actorId: ADMIN,
          now: at('2026-10-01T09:00'),
        }),
      'GO_LIVE_IN_FUTURE'
    );
    await expectCode(
      'A5 go-live refused before the sale',
      () =>
        billingService.markLive({
          organizationId: org,
          goLiveOn: '2026-09-20',
          note: 'backdated',
          actorId: ADMIN,
          now: at('2026-09-26T12:00'),
        }),
      'GO_LIVE_BEFORE_SALE'
    );
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Installed and printing',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await expectCode(
      'A6 go-live cannot be recorded twice',
      () =>
        billingService.markLive({
          organizationId: org,
          goLiveOn: '2026-10-01',
          note: 'again',
          actorId: ADMIN,
          now: at('2026-10-02T09:00'),
        }),
      'ALREADY_LIVE'
    );

    await billingService.raiseDueCharges(at('2026-10-15T06:00'));
    await billingService.raiseDueCharges(at('2026-10-31T23:00'));
    check(
      'A7 no bill during the free month',
      (await charges(org)).filter((c) => c.kind === 'software').length === 0
    );
    const octView = await view(org, at('2026-10-20T10:00'));
    check(
      'A8 free month shows as free, next payment is 1 Nov at ₹499',
      octView?.phase === 'free' &&
        octView.nextPayment?.dueOn === '2026-11-01' &&
        octView.nextPayment?.amount === 499,
      JSON.stringify(octView?.nextPayment)
    );

    await billingService.raiseDueCharges(at('2026-11-01T06:00'));
    const sw = (await charges(org)).filter((c) => c.kind === 'software');
    check(
      'A9 month 2 is raised on 1 Nov with its own due date and period',
      sw.length === 1 &&
        sw[0].period_index === 1 + 1 &&
        sw[0].due_on === '2026-11-01' &&
        sw[0].period_end === '2026-11-30',
      JSON.stringify(sw)
    );
    check(
      'A10 on 3 Nov the bill is due, within grace',
      (await view(org, at('2026-11-03T10:00')))?.phase === 'payment_due'
    );

    const novA = (
      await rows(
        `SELECT ch.id FROM billing_charges ch JOIN partner_contracts c ON c.id=ch.contract_id WHERE c.organization_id=$1 AND ch.kind='software'`,
        [org]
      )
    )[0].id as string;
    await billingService.settleCharge({
      chargeId: novA,
      action: 'paid',
      method: 'bank_transfer',
      reference: 'NEFT-A2',
      actorId: ADMIN,
      now: at('2026-11-03T12:00'),
    });
    check(
      'A11 November paid by bank transfer, reference kept',
      (await charges(org)).some(
        (c) => c.kind === 'software' && c.status === 'paid' && c.payment_reference === 'NEFT-A2'
      )
    );

    await billingService.raiseDueCharges(at('2026-12-01T06:00'));
    check(
      'A12 on 5 Dec December is due and still in grace',
      (await view(org, at('2026-12-05T10:00')))?.phase === 'payment_due'
    );
    check(
      'A13 on 7 Dec December is overdue, after the grace day',
      (await view(org, at('2026-12-07T10:00')))?.phase === 'overdue'
    );

    const decId = (
      await rows(
        `SELECT ch.id FROM billing_charges ch JOIN partner_contracts c ON c.id=ch.contract_id WHERE c.organization_id=$1 AND ch.period_index=3`,
        [org]
      )
    )[0].id as string;
    await billingService.settleCharge({
      chargeId: decId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-12-08T12:00'),
    });
    const active = await view(org, at('2026-12-08T13:00'));
    check(
      'A14 after paying late, the partner is active again, paid through 31 Dec',
      active?.phase === 'active' && active.paidThrough === '2026-12-31',
      `${active?.phase} ${active?.paidThrough}`
    );

    await billingService.raiseDueCharges(at('2027-01-01T06:00'));
    check(
      'A15 January is raised on 1 Jan: three billable months in all (Nov, Dec, Jan)',
      (await charges(org)).filter((c) => c.kind === 'software').length === 3
    );
    const before16 = (await charges(org)).length;
    await billingService.raiseDueCharges(at('2027-01-01T07:00'));
    check(
      'A16 a re-run on the same day creates nothing for this partner',
      (await charges(org)).length === before16
    );
  }

  // ----- B. Downtime: the job catches up, and does not double-bill -------------
  {
    const org = await partner('B');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Launch offer',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'waive',
      note: 'Launch offer, approved',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    // raiseDueCharges is platform-wide, so the check counts this partner's rows only.
    await billingService.raiseDueCharges(at('2027-01-15T06:00'));
    const caughtUp = (await charges(org)).filter((c) => c.kind === 'software').length;
    check(
      'B1 server down for months: each missed month raised, once each',
      caughtUp === 3,
      `software charges ${caughtUp}`
    );
    check(
      'B2 each month keeps its own due date',
      (await charges(org))
        .filter((c) => c.kind === 'software')
        .map((c) => c.due_on)
        .join(',') === '2026-11-01,2026-12-01,2027-01-01'
    );
    check(
      'B3 a waived hardware still lets the partner go live',
      (await contract(org))?.go_live_on === '2026-10-01'
    );
    const again = await billingService.raiseDueCharges(at('2027-01-15T06:05'));
    check(
      'B4 repeated run creates no duplicates',
      again.created === 0 && (await charges(org)).length === 4
    );

    const nov = (
      await rows(
        `SELECT ch.id FROM billing_charges ch JOIN partner_contracts c ON c.id=ch.contract_id WHERE c.organization_id=$1 AND ch.period_index=2`,
        [org]
      )
    )[0].id as string;
    await billingService.settleCharge({
      chargeId: nov,
      action: 'waive',
      note: 'Goodwill for the outage',
      actorId: ADMIN,
      now: at('2027-01-16T10:00'),
    });
    check(
      'B5 a waived month counts as covered, so paid through moves to 30 Nov',
      (await view(org, at('2027-01-16T11:00')))?.paidThrough === '2026-11-30'
    );
  }

  // ----- C. Concurrency: two runs at once create each charge once --------------
  {
    const org = await partner('C');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Race test',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await Promise.all([
      billingService.raiseDueCharges(at('2026-12-15T06:00')),
      billingService.raiseDueCharges(at('2026-12-15T06:00')),
    ]);
    const raised = (await charges(org)).filter((c) => c.kind === 'software');
    const distinct = new Set(raised.map((c) => c.period_index)).size;
    check(
      'C1 two simultaneous runs raise each month exactly once',
      raised.length === 2 && distinct === 2,
      `rows ${raised.length}, distinct months ${distinct}`
    );
  }

  // ----- D. Concurrency: two people settling the same charge -------------------
  {
    const org = await partner('D');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Race test 2',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await billingService.raiseDueCharges(at('2026-11-02T06:00'));
    const nov = (
      await rows(
        `SELECT ch.id FROM billing_charges ch JOIN partner_contracts c ON c.id=ch.contract_id WHERE c.organization_id=$1 AND ch.kind='software'`,
        [org]
      )
    )[0].id as string;
    const settle = (ref: string) =>
      billingService.settleCharge({
        chargeId: nov,
        action: 'paid',
        method: 'upi',
        reference: ref,
        actorId: ADMIN,
        now: at('2026-11-02T10:00'),
      });
    const outcomes = await Promise.allSettled([settle('UTR-D1'), settle('UTR-D2')]);
    const won = outcomes.filter((o) => o.status === 'fulfilled').length;
    const lost = outcomes.filter(
      (o) => o.status === 'rejected' && (o.reason as AppError).code === 'ALREADY_SETTLED'
    ).length;
    check(
      'D1 two simultaneous payments: exactly one is recorded, the other refused',
      won === 1 && lost === 1,
      `won ${won}, lost ${lost}`
    );
    const stored = await rows(`SELECT payment_reference FROM billing_charges WHERE id = $1`, [nov]);
    check(
      'D2 the recorded reference is the winner’s, not overwritten',
      ['UTR-D1', 'UTR-D2'].includes(String(stored[0].payment_reference))
    );
  }

  // ----- E. Refusals and validation (no state may change on refusal) -----------
  {
    const org = await partner('E');
    const before = await rows(`SELECT COUNT(*)::int AS n FROM billing_charges`);
    await expectCode(
      'E1 a revenue-share partner cannot be sold a Model 1 contract',
      async () =>
        billingService.recordSale({
          organizationId: await partner('E-2A', 'revenue-share'),
          note: 'wrong model',
          actorId: ADMIN,
          now: at('2026-09-25T10:00'),
        }),
      'NOT_MODEL_1'
    );
    await expectCode(
      'E2 a sale before any price exists is refused, not guessed',
      () =>
        billingService.recordSale({
          organizationId: org,
          note: 'too early',
          actorId: ADMIN,
          now: at('2025-06-01T10:00'),
        }),
      'NO_PLAN'
    );
    try {
      await billingService.recordSale({
        organizationId: '00000000-0000-4000-8000-00000000dead',
        note: 'ghost',
        actorId: ADMIN,
        now: at('2026-09-25T10:00'),
      });
      check('E3 an unknown partner is refused', false, 'accepted');
    } catch (error) {
      check(
        'E3 an unknown partner is refused with 404',
        error instanceof AppError && error.statusCode === 404,
        String(error)
      );
    }
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'First sale',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await expectCode(
      'E4 a second sale to the same partner is refused',
      () =>
        billingService.recordSale({
          organizationId: org,
          note: 'Second sale',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'CONTRACT_EXISTS'
    );
    await expectCode(
      'E5 settling without a method is refused',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'paid',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'BAD_METHOD'
    );
    await expectCode(
      'E6 a bank transfer without its reference is refused',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'paid',
          method: 'bank_transfer',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'REFERENCE_REQUIRED'
    );
    await expectCode(
      'E7 a UPI payment with a too-short reference is refused',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'paid',
          method: 'upi',
          reference: 'ab',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'REFERENCE_REQUIRED'
    );
    await expectCode(
      'E8 a waiver without a reason is refused',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'waive',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'REASON_REQUIRED'
    );
    await expectCode(
      'E9 go-live for a partner with no contract is refused',
      async () =>
        billingService.markLive({
          organizationId: await partner('E-none'),
          goLiveOn: '2026-09-26',
          note: 'no contract',
          actorId: ADMIN,
          now: at('2026-09-26T10:00'),
        }),
      'NO_CONTRACT'
    );
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cheque',
      reference: 'CHQ-000123',
      actorId: ADMIN,
      now: at('2026-09-26T10:00'),
    });
    await expectCode(
      'E10 a paid charge cannot be paid again',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'paid',
          method: 'cash',
          actorId: ADMIN,
          now: at('2026-09-27T10:00'),
        }),
      'ALREADY_SETTLED'
    );
    await expectCode(
      'E11 a paid charge cannot be waived after the fact',
      () =>
        billingService.settleCharge({
          chargeId: sale.chargeId,
          action: 'waive',
          note: 'changed mind',
          actorId: ADMIN,
          now: at('2026-09-27T10:00'),
        }),
      'ALREADY_SETTLED'
    );
    const after = await rows(`SELECT COUNT(*)::int AS n FROM billing_charges`);
    check(
      'E12 only the one successful sale created a charge; every refusal created none',
      Number(after[0].n) === Number(before[0].n) + 1,
      JSON.stringify({ before: before[0].n, after: after[0].n })
    );
    try {
      await rows(
        `INSERT INTO billing_plan_terms (business_model, hardware_price, monthly_price, free_months, grace_days, note) VALUES ('integration', 100, -1, 0, 0, 'negative')`
      );
      check(
        'E13 a negative price is refused by the database, even if the API were bypassed',
        false,
        'accepted'
      );
    } catch (error) {
      check(
        'E13 a negative price is refused by the database, even if the API were bypassed',
        (error as { code?: string }).code === '23514',
        String(error)
      );
    }
  }

  // ----- F. A price change never touches a contract already sold ----------------
  {
    const existing = await partner('F-existing');
    const s1 = await billingService.recordSale({
      organizationId: existing,
      note: 'Sold at 499',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: s1.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: existing,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });

    await billingService.setPlan(
      {
        hardwarePrice: 19999,
        monthlyPrice: 999,
        freeMonths: 1,
        graceDays: 5,
        effectiveFrom: at('2027-01-01T00:00'),
        note: 'New list price',
        actorId: ADMIN,
      },
      at('2026-12-20T10:00')
    );
    const newSale = await billingService.recordSale({
      organizationId: await partner('F-new'),
      note: 'Sold at 999',
      actorId: ADMIN,
      now: at('2027-01-05T10:00'),
    });
    const newContract = await rows(
      `SELECT monthly_price::float8 AS m, hardware_price::float8 AS h FROM partner_contracts WHERE id = $1`,
      [newSale.contractId]
    );
    check(
      'F1 a sale after the change takes the new prices',
      Number(newContract[0].m) === 999 && Number(newContract[0].h) === 19999
    );

    await billingService.raiseDueCharges(at('2027-02-01T06:00'));
    const feb = (await charges(existing)).filter(
      (c) => c.kind === 'software' && c.due_on === '2027-02-01'
    );
    check(
      'F2 the existing partner is still charged the price it was sold on',
      feb.length === 1 && Number(feb[0].amount) === 499,
      JSON.stringify(feb)
    );
    check(
      'F3 the plan change left the existing contract’s snapshot unchanged',
      Number((await contract(existing))?.monthly_price) === 499
    );
  }

  // ----- G. A partner that leaves Model 1 is not billed under the old contract --
  {
    const org = await partner('G');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Will change model',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await rows(`UPDATE organizations SET business_model = 'revenue-share' WHERE id = $1`, [org]);
    const run = await billingService.raiseDueCharges(at('2026-11-02T06:00'));
    check(
      'G1 a partner moved off Model 1 is not billed; the run says why',
      (await charges(org)).filter((c) => c.kind === 'software').length === 0 &&
        run.skipped.some((s) => s.includes('model is now')),
      JSON.stringify(run.skipped)
    );
  }

  // ----- H. A free-forever price: no monthly bill at all -------------------------
  {
    await billingService.setPlan(
      {
        hardwarePrice: 18999,
        monthlyPrice: 0,
        freeMonths: 1,
        graceDays: 5,
        effectiveFrom: at('2030-01-01T00:00'),
        note: 'Free software (scenario)',
        actorId: ADMIN,
      },
      at('2030-01-01T00:00')
    );
    const org = await partner('H');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Free software',
      actorId: ADMIN,
      now: at('2030-01-02T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2030-01-02T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2030-01-02',
      note: 'Live',
      actorId: ADMIN,
      now: at('2030-01-02T12:00'),
    });
    await billingService.raiseDueCharges(at('2030-06-01T06:00'));
    check(
      'H1 a zero monthly price raises no software charges',
      (await charges(org)).filter((c) => c.kind === 'software').length === 0
    );
  }

  // ----- I. A go-live on the 31st: clamped months, still anchored --------------
  {
    const org = await partner('I');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'End-of-month go-live',
      actorId: ADMIN,
      now: at('2027-01-20T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2027-01-20T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2027-01-31',
      note: 'Live on the 31st',
      actorId: ADMIN,
      now: at('2027-02-01T09:00'),
    });
    await billingService.raiseDueCharges(at('2027-02-27T06:00'));
    check(
      'I1 nothing is raised before the second month begins on 28 Feb',
      (await charges(org)).filter((c) => c.kind === 'software').length === 0
    );
    await billingService.raiseDueCharges(at('2027-02-28T06:00'));
    await billingService.raiseDueCharges(at('2027-03-31T06:00'));
    const sw = (await charges(org)).filter((c) => c.kind === 'software');
    check(
      'I2 the second month starts on 28 Feb (clamped), the third on 31 Mar (anchored, not drifted)',
      sw.length === 2 && sw[0].due_on === '2027-02-28' && sw[1].due_on === '2027-03-31',
      JSON.stringify(sw.map((c) => c.due_on))
    );
    check(
      'I3 the second month runs 28 Feb to 30 Mar',
      sw[0].period_end === '2027-03-30',
      String(sw[0].period_end)
    );
  }

  // ----- J. Time zone: the sale day is the India day, not the UTC day ----------
  {
    const org = await partner('J');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Just after midnight India time',
      actorId: ADMIN,
      now: at('2026-09-26T00:30'),
    });
    const hw = (await charges(org))[0];
    check(
      'J1 a sale at 00:30 IST is due on that India date, not the UTC date before',
      hw.due_on === '2026-09-26',
      String(hw.due_on)
    );
    check(
      'J2 istDate reads India time at the boundary',
      istDate(new Date('2026-09-25T19:00:00Z')) === '2026-09-26'
    );
    void sale;
  }

  // ----- K. The partner view never leaks internal fields -----------------------
  {
    const org = await partner('K');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'INTERNAL sale note',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'upi',
      reference: 'UTR-SECRET-K',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'INTERNAL go-live note',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await billingService.raiseDueCharges(at('2026-11-02T06:00'));
    const internal = await view(org, at('2026-11-02T07:00'), true);
    const shop = toShopContract(internal!);
    const shopJson = JSON.stringify(shop);
    check(
      'K1 the partner’s view has no internal note, reference or staff email',
      !shopJson.includes('INTERNAL') &&
        !shopJson.includes('UTR-SECRET-K') &&
        !shopJson.includes('@mprnt.test') &&
        !shopJson.includes('"paymentReference"')
    );
    check(
      'K2 the super admin’s view does carry the reference',
      JSON.stringify(internal).includes('UTR-SECRET-K')
    );
    const shopFromDb = await view(org, at('2026-11-02T07:00'), false);
    check(
      'K3 the partner view built from the database has no reference either',
      !JSON.stringify(shopFromDb).includes('UTR-SECRET-K')
    );
    check(
      'K4 the partner view says the subscription is payment due, with the next payment',
      shop.phase === 'payment_due' && shop.nextPayment?.amount === 499
    );
    void toInvoice;
  }

  // ----- L. Derived state agrees with the database --------------------------------
  {
    const org = await partner('L');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Reconcile',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await billingService.raiseDueCharges(at('2026-12-02T06:00'));
    const v = await view(org, at('2026-12-02T07:00'));
    const sumOwed = v!.owed.reduce((n, o) => n + o.charge.amount, 0);
    const dbOwed = (await charges(org))
      .filter((c) => c.status === 'due')
      .reduce((n, c) => n + Number(c.amount), 0);
    check(
      'L1 amount owed in the view equals the amount owed in the database',
      sumOwed === dbOwed && dbOwed === 998,
      `view ${sumOwed}, db ${dbOwed}`
    );
  }

  // ----- M. A deleted partner is never billed -----------------------------------
  {
    const org = await partner('M');
    const sale = await billingService.recordSale({
      organizationId: org,
      note: 'Will be deleted',
      actorId: ADMIN,
      now: at('2026-09-25T10:00'),
    });
    await billingService.settleCharge({
      chargeId: sale.chargeId,
      action: 'paid',
      method: 'cash',
      actorId: ADMIN,
      now: at('2026-09-25T11:00'),
    });
    await billingService.markLive({
      organizationId: org,
      goLiveOn: '2026-10-01',
      note: 'Live',
      actorId: ADMIN,
      now: at('2026-10-01T09:00'),
    });
    await rows(`UPDATE organizations SET deleted_at = NOW() WHERE id = $1`, [org]);
    const run = await billingService.raiseDueCharges(at('2026-11-02T06:00'));
    check(
      'M1 a deleted partner is not billed',
      (await charges(org)).filter((c) => c.kind === 'software').length === 0 &&
        run.skipped.includes('deleted partner')
    );
  }

  // ----- N. The portfolio agrees with the individual contracts ------------------
  {
    const list = await billingService.listContracts(at('2026-12-08T13:00'));
    const rowA = list.rows.find((r) => r.organizationId === ids.A);
    check(
      'N1 the portfolio lists each contract with its current state',
      !!rowA && rowA.phase === 'active',
      JSON.stringify(rowA?.phase)
    );
    check(
      'N2 the portfolio totals add up to the contracts listed',
      list.totals.contracts === list.rows.length
    );
  }

  // ----- Report ------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  void addMonths;
  void deriveContract;
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Scenario run crashed:', error);
  process.exit(2);
});
