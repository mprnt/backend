import { BillingService } from '../../src/services/billingService';
import { scriptedDb, Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const ORG = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const CHARGE = '33333333-3333-4333-8333-333333333333';

/**
 * A fake database whose audit insert fails. Every other statement behaves as
 * the scripted rules say. Used to prove the money change is rolled back with it.
 */
function brokenAudit(rules: Rule[]) {
  const base = scriptedDb(rules);
  const log: string[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const text = String(sql).trim();
    log.push(text.split(/\s+/).slice(0, 2).join(' '));
    if (text.includes('INSERT INTO audit_logs')) {
      throw new Error('audit write failed');
    }
    return base.query(sql, params);
  });
  const client = { query, release: jest.fn() };
  const database = { query, getClient: jest.fn(async () => client) };
  return { database, log };
}

describe('a money change is only kept if its audit row is written', () => {
  it('a failed audit write rolls back a sale: no COMMIT, and the error reaches the caller', async () => {
    const { database, log } = brokenAudit([
      ['FOR UPDATE', [{ business_model: 'integration' }]],
      ['SELECT 1 FROM partner_contracts', []],
      [
        'FROM billing_plan_terms',
        [
          {
            id: 'P1',
            hardware_price: '18999',
            monthly_price: '499',
            free_months: 1,
            grace_days: 5,
          },
        ],
      ],
      ['INSERT INTO partner_contracts', [{ id: 'C1' }]],
      ['INSERT INTO billing_charges', [{ id: CHARGE }]],
    ]);
    const svc = new BillingService(database as never);

    await expect(
      svc.recordSale({
        organizationId: ORG,
        note: 'Sold',
        actorId: ADMIN,
        now: new Date('2026-09-25T10:00:00+05:30'),
      })
    ).rejects.toThrow('audit write failed');

    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('a failed audit write rolls back a payment: the charge stays due', async () => {
    const { database, log } = brokenAudit([
      [
        'FOR UPDATE OF ch',
        [{ status: 'due', kind: 'software', amount: '499', organization_id: ORG }],
      ],
    ]);
    const svc = new BillingService(database as never);

    await expect(
      svc.settleCharge({
        chargeId: CHARGE,
        action: 'paid',
        method: 'upi',
        reference: 'UTR-AUDIT-1',
        actorId: ADMIN,
        now: new Date('2026-11-03T10:00:00+05:30'),
      })
    ).rejects.toThrow('audit write failed');

    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });

  it('a failed audit write rolls back the go-live date too', async () => {
    const { database, log } = brokenAudit([
      [
        'FOR UPDATE OF c',
        [
          {
            contract_id: 'C1',
            go_live_on: null,
            sold_on: '2026-09-25',
            business_model: 'integration',
            hw_status: 'paid',
          },
        ],
      ],
    ]);
    const svc = new BillingService(database as never);

    await expect(
      svc.markLive({
        organizationId: ORG,
        goLiveOn: '2026-10-01',
        note: 'Installed',
        actorId: ADMIN,
        now: new Date('2026-10-01T09:00:00+05:30'),
      })
    ).rejects.toThrow('audit write failed');

    expect(log).toContain('ROLLBACK');
    expect(log).not.toContain('COMMIT');
  });
});
