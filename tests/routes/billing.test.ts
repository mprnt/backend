import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';
import { Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const API = '/api/v1/admin';
const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '55555555-5555-4555-8555-555555555555';
const CHARGE = '66666666-6666-4666-8666-666666666666';

const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;
const SUPER = { role: 'super_admin', org: null, perms: ['billing:read', 'billing:write'] };
const OWNER = { role: 'owner', org: OWN, perms: ['billing:read'] };
const MANAGER = { role: 'manager', org: OWN, perms: ['billing:read'] };
const VIEWER = { role: 'viewer', org: OWN, perms: [] };

const orgRow = (model: string | null = 'integration'): Rule => [
  'FROM organizations WHERE id',
  [{ name: 'Shop 3', business_model: model, id: OWN }],
];

const contractRule: Rule = [
  'WHERE c.organization_id = $1',
  [
    {
      id: 'C1',
      organization_id: OWN,
      go_live_on: '2026-01-01',
      sold_on: '2025-12-25',
      sale_note: 'INTERNAL sale note',
      go_live_note: 'INTERNAL go-live note',
      sold_by_email: 'sales@mprnt.test',
      go_live_by_email: 'ops@mprnt.test',
      hardware_price: '18999',
      monthly_price: '499',
      free_months: 1,
      grace_days: 5,
    },
  ],
];

const chargeRows: Rule = [
  'FROM billing_charges ch',
  [
    {
      contract_id: 'C1',
      id: 'H1',
      kind: 'hardware',
      period_index: 0,
      period_start: '2025-12-25',
      period_end: '2025-12-25',
      amount: '18999',
      due_on: '2025-12-25',
      status: 'paid',
      settled_on: '2025-12-26',
      payment_method: 'upi',
      payment_reference: 'UTR-SECRET-9',
      settle_note: null,
      settled_by_email: 'accounts@mprnt.test',
    },
    {
      contract_id: 'C1',
      id: 'S2',
      kind: 'software',
      period_index: 2,
      period_start: '2026-02-01',
      period_end: '2026-02-28',
      amount: '499',
      due_on: '2026-02-01',
      status: 'due',
      settled_on: null,
      payment_method: null,
      payment_reference: null,
      settle_note: null,
      settled_by_email: null,
    },
  ],
];

describe('GET /admin/billing/contract: a partner reads only its own bill', () => {
  it('401 without a token', async () => {
    useScriptedDb([]);
    expect((await request(app).get(`${API}/billing/contract`)).status).toBe(401);
  });

  it('403 for a viewer, who has no billing permission', async () => {
    useScriptedDb([orgRow()]);
    const res = await request(app)
      .get(`${API}/billing/contract`)
      .set('Authorization', bearer(VIEWER));
    expect(res.status).toBe(403);
  });

  it('a partner with no contract is told so, and nothing else', async () => {
    useScriptedDb([orgRow()]);
    const res = await request(app)
      .get(`${API}/billing/contract`)
      .set('Authorization', bearer(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ hasContract: false, contract: null });
  });

  it('a partner sees its dates and invoices, but none of the internal detail', async () => {
    useScriptedDb([orgRow(), contractRule, chargeRows]);
    const res = await request(app)
      .get(`${API}/billing/contract`)
      .set('Authorization', bearer(MANAGER));

    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(res.body.data.hasContract).toBe(true);
    // February was due on 1 Feb, so it is past its grace period whatever today is.
    expect(res.body.data.contract.phase).toBe('overdue');
    expect(res.body.data.contract.nextPayment).toMatchObject({
      amount: 499,
      dueOn: '2026-02-01',
      kind: 'software',
    });
    for (const leaked of [
      'INTERNAL',
      'UTR-SECRET-9',
      'accounts@mprnt.test',
      'sales@mprnt.test',
      'ops@mprnt.test',
      'paymentReference',
      'settledByEmail',
      'saleNote',
      'graceDays',
      'businessModel',
      'owed',
      '"hardware":',
    ]) {
      expect(body).not.toContain(leaked);
    }
  });

  it("a shop cannot read another partner's bill by naming it", async () => {
    useScriptedDb([orgRow(), contractRule, chargeRows]);
    const res = await request(app)
      .get(`${API}/billing/contract?organizationId=${OTHER}`)
      .set('Authorization', bearer(OWNER));
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('a super admin must name the partner', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/billing/contract`)
      .set('Authorization', bearer(SUPER));
    expect(res.status).toBe(400);
  });

  it('a super admin sees the internal detail, including who recorded what', async () => {
    useScriptedDb([orgRow(), contractRule, chargeRows]);
    const res = await request(app)
      .get(`${API}/billing/contract?organizationId=${OWN}`)
      .set('Authorization', bearer(SUPER));
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('UTR-SECRET-9');
    expect(body).toContain('sales@mprnt.test');
    expect(res.body.data.contract.owed).toBeDefined();
  });
});

describe('platform-only writes', () => {
  const plan = {
    hardwarePrice: 18999,
    monthlyPrice: 499,
    freeMonths: 1,
    graceDays: 5,
    note: 'Standard Model 1 price',
  };

  it('an owner holding billing:write still cannot publish prices', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/billing/plans`)
      .set(
        'Authorization',
        bearer({ role: 'owner', org: OWN, perms: ['billing:write', 'billing:read'] })
      )
      .send(plan);
    expect(res.status).toBe(403);
    expect(db.sqlFor('INSERT INTO billing_plan_terms')).toHaveLength(0);
  });

  it('a super admin without the permission is refused too', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/billing/plans`)
      .set('Authorization', bearer({ role: 'super_admin', org: null, perms: ['billing:read'] }))
      .send(plan);
    expect(res.status).toBe(403);
  });

  it('a shop cannot record a sale, mark live, or settle a charge', async () => {
    const db = useScriptedDb([orgRow()]);
    const owner = bearer({ role: 'owner', org: OWN, perms: ['billing:read', 'billing:write'] });
    expect(
      (
        await request(app)
          .post(`${API}/billing/contract`)
          .set('Authorization', owner)
          .send({ organizationId: OWN, note: 'self sale' })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${API}/billing/contract/go-live`)
          .set('Authorization', owner)
          .send({ organizationId: OWN, goLiveOn: '2026-10-01', note: 'self live' })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${API}/billing/charges/${CHARGE}/settle`)
          .set('Authorization', owner)
          .send({ action: 'waive', note: 'free for me' })
      ).status
    ).toBe(403);
    expect(db.sqlFor('UPDATE billing_charges')).toHaveLength(0);
    expect(db.sqlFor('INSERT INTO partner_contracts')).toHaveLength(0);
  });

  it('a shop cannot list every partner’s contracts or read the price list', async () => {
    useScriptedDb([]);
    expect(
      (await request(app).get(`${API}/billing/contracts`).set('Authorization', bearer(OWNER)))
        .status
    ).toBe(403);
    expect(
      (await request(app).get(`${API}/billing/plans`).set('Authorization', bearer(OWNER))).status
    ).toBe(403);
  });
});

describe('validation: nothing malformed reaches the money', () => {
  const superBearer = bearer(SUPER);

  it('refuses a negative hardware price and a free period over 12 months', async () => {
    useScriptedDb([]);
    const neg = await request(app)
      .post(`${API}/billing/plans`)
      .set('Authorization', superBearer)
      .send({ hardwarePrice: -1, monthlyPrice: 499, freeMonths: 1, graceDays: 5, note: 'bad' });
    expect(neg.status).toBe(400);
    const long = await request(app)
      .post(`${API}/billing/plans`)
      .set('Authorization', superBearer)
      .send({
        hardwarePrice: 18999,
        monthlyPrice: 499,
        freeMonths: 13,
        graceDays: 5,
        note: 'too free',
      });
    expect(long.status).toBe(400);
  });

  it('a GST-exclusive flag sent by a client is stripped, never stored', async () => {
    const db = useScriptedDb([
      ['INSERT INTO billing_plan_terms', [{ id: 'P1', effective_from: new Date() }]],
    ]);
    const res = await request(app)
      .post(`${API}/billing/plans`)
      .set('Authorization', superBearer)
      .send({
        hardwarePrice: 18999,
        monthlyPrice: 499,
        freeMonths: 1,
        graceDays: 5,
        note: 'Standard',
        gstInclusive: false,
      });
    expect(res.status).toBe(201);
    const insert = db.sqlFor('INSERT INTO billing_plan_terms')[0];
    expect(insert.params).not.toContain(false);
    expect(insert.sql).not.toContain('gst_inclusive');
  });

  it('a note shorter than three characters is refused for every money action', async () => {
    useScriptedDb([]);
    const shortNote = { organizationId: OWN, note: 'ok' };
    expect(
      (
        await request(app)
          .post(`${API}/billing/contract`)
          .set('Authorization', superBearer)
          .send(shortNote)
      ).status
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`${API}/billing/contract/go-live`)
          .set('Authorization', superBearer)
          .send({ organizationId: OWN, goLiveOn: '2026-10-01', note: 'x' })
      ).status
    ).toBe(400);
  });

  it('go-live must be a calendar date; 30 February is refused', async () => {
    useScriptedDb([['FROM partner_contracts c', []]]);
    const res = await request(app)
      .post(`${API}/billing/contract/go-live`)
      .set('Authorization', superBearer)
      .send({ organizationId: OWN, goLiveOn: '2026-02-30', note: 'impossible date' });
    expect(res.status).toBe(400);
  });

  it('a payment must name how it was made, and a waiver must not', async () => {
    useScriptedDb([]);
    const noMethod = await request(app)
      .post(`${API}/billing/charges/${CHARGE}/settle`)
      .set('Authorization', superBearer)
      .send({ action: 'paid' });
    expect(noMethod.status).toBe(400);
    const waiverWithMethod = await request(app)
      .post(`${API}/billing/charges/${CHARGE}/settle`)
      .set('Authorization', superBearer)
      .send({ action: 'waive', note: 'Goodwill', method: 'cash' });
    expect(waiverWithMethod.status).toBe(400);
  });

  it('a charge id that is not a UUID is refused before the database is touched', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/billing/charges/not-a-uuid/settle`)
      .set('Authorization', superBearer)
      .send({ action: 'waive', note: 'Goodwill' });
    expect(res.status).toBe(400);
    expect(db.sqlFor('billing_charges')).toHaveLength(0);
  });

  it('a bank transfer without its reference is refused by the service, and nothing is written', async () => {
    const db = useScriptedDb([
      [
        'FOR UPDATE OF ch',
        [{ status: 'due', kind: 'software', amount: '499', organization_id: OWN }],
      ],
    ]);
    const res = await request(app)
      .post(`${API}/billing/charges/${CHARGE}/settle`)
      .set('Authorization', superBearer)
      .send({ action: 'paid', method: 'bank_transfer' });
    expect(res.status).toBe(400);
    expect(db.sqlFor('UPDATE billing_charges')).toHaveLength(0);
  });

  it('an already-settled charge cannot be settled again', async () => {
    useScriptedDb([
      [
        'FOR UPDATE OF ch',
        [{ status: 'paid', kind: 'software', amount: '499', organization_id: OWN }],
      ],
    ]);
    const res = await request(app)
      .post(`${API}/billing/charges/${CHARGE}/settle`)
      .set('Authorization', superBearer)
      .send({ action: 'paid', method: 'cash' });
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('ALREADY_SETTLED');
  });
});

describe('a super admin can publish a price and record a sale', () => {
  it('publishes a Model 1 price (201)', async () => {
    const db = useScriptedDb([
      [
        'INSERT INTO billing_plan_terms',
        [{ id: 'P2', effective_from: new Date('2026-10-15T00:00:00Z') }],
      ],
    ]);
    const res = await request(app)
      .post(`${API}/billing/plans`)
      .set('Authorization', bearer(SUPER))
      .send({
        hardwarePrice: 18999,
        monthlyPrice: 499,
        freeMonths: 1,
        graceDays: 5,
        note: 'Standard Model 1 price',
      });
    expect(res.status).toBe(201);
    expect(db.sqlFor('INSERT INTO billing_plan_terms')).toHaveLength(1);
    expect(db.sqlFor('INSERT INTO audit_logs').length).toBeGreaterThan(0);
  });

  it('records a sale only for a Model 1 partner with a price in force (201), and audits it', async () => {
    const db = useScriptedDb([
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
      ['INSERT INTO billing_charges', [{ id: 'H1' }]],
    ]);
    const res = await request(app)
      .post(`${API}/billing/contract`)
      .set('Authorization', bearer(SUPER))
      .send({ organizationId: OWN, note: 'Sold at the counter' });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ contractId: 'C1', chargeId: 'H1' });
    const insert = db.sqlFor('INSERT INTO partner_contracts')[0];
    expect(insert.params).toEqual(
      expect.arrayContaining([OWN, 'P1', 'integration', 18999, 499, 1, 5])
    );
    expect(db.sqlFor('INSERT INTO audit_logs').length).toBeGreaterThan(0);
  });

  it('refuses a sale for a partner that is not on Model 1 (409), and creates nothing', async () => {
    const db = useScriptedDb([['FOR UPDATE', [{ business_model: 'revenue-share' }]]]);
    const res = await request(app)
      .post(`${API}/billing/contract`)
      .set('Authorization', bearer(SUPER))
      .send({ organizationId: OWN, note: 'wrong model' });
    expect(res.status).toBe(409);
    expect(db.sqlFor('INSERT INTO partner_contracts')).toHaveLength(0);
  });
});
