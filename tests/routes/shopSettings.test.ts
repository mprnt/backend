import request from 'supertest';
import app from '../../src/app';
import env from '../../src/config/environment';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');

const API = '/api/v1/admin';
const OWN = '11111111-1111-4111-8111-111111111111';
const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;

const OWNER = { role: 'owner', org: OWN, perms: ['shop:profile:write', 'shop:pricing:write'] };
const MANAGER = { role: 'manager', org: OWN, perms: ['shop:pricing:write'] };
const VIEWER = { role: 'viewer', org: OWN, perms: ['reports:read'] };
const SUPER = { role: 'super_admin', org: null, perms: ['orgs:write'] };

const KEY = Buffer.alloc(32, 7).toString('base64');

const shopRow = {
  id: OWN,
  name: 'Shop 1',
  slug: 'shop-1',
  status: 'active',
  business_model: 'integration',
  timezone: 'Asia/Kolkata',
  contact_email: 'owner@shop.test',
  contact_phone: null,
  contact_updated_by_scope: 'shop',
  contact_updated_at: new Date('2026-10-28T10:00:00Z'),
  bank_account_holder: 'Sharma Stores',
  bank_name: 'HDFC Bank',
  bank_ifsc: 'HDFC0001234',
  bank_account_last4: '9012',
  upi_id: 'sharma@hdfc',
  payout_updated_by_scope: 'shop',
  payout_updated_at: new Date('2026-10-28T10:05:00Z'),
  created_at: new Date('2026-09-28T12:57:12Z'),
  member_since: '2026-09-28T12:57:12Z',
  qr_points: '1',
  printers: '2',
  stations: '0',
  revenue: '0',
  paid_jobs: '0',
  completed_jobs: '0',
  pages_printed: '0',
  first_sale_at: null,
};

const savedRate = {
  id: 'pl-9',
  organization_id: OWN,
  kiosk_id: null,
  bw_per_page: '1.5',
  color_per_page: '4',
  min_charge: '0',
};

describe('shop pricing - the shop sets its own black-and-white and colour rate', () => {
  it('an owner publishes a rate for their own shop, from now on', async () => {
    const db = useScriptedDb([
      ['SELECT min_charge FROM price_lists', [{ min_charge: '0' }]],
      ['INSERT INTO price_lists', [savedRate]],
    ]);

    const res = await request(app)
      .put(`${API}/shop/pricing`)
      .set('Authorization', bearer(OWNER))
      .send({ bwPerPage: 1.5, colorPerPage: 4 });

    expect(res.status).toBe(201);
    const insert = db.sqlFor('INSERT INTO price_lists');
    expect(insert).toHaveLength(1);
    // The shop is the caller's own, and the rate names the caller as its author.
    expect(insert[0].params).toEqual([OWN, 1.5, 4, 0, 'admin-1']);
  });

  it('a manager may publish the shop rate too', async () => {
    useScriptedDb([
      ['SELECT min_charge FROM price_lists', [{ min_charge: '0' }]],
      ['INSERT INTO price_lists', [savedRate]],
    ]);

    const res = await request(app)
      .put(`${API}/shop/pricing`)
      .set('Authorization', bearer(MANAGER))
      .send({ bwPerPage: 1.5, colorPerPage: 4 });

    expect(res.status).toBe(201);
  });

  it('a viewer cannot publish a rate', async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .put(`${API}/shop/pricing`)
      .set('Authorization', bearer(VIEWER))
      .send({ bwPerPage: 1.5, colorPerPage: 4 });

    expect(res.status).toBe(403);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(0);
  });

  it('a super admin has no shop, so has no shop rate to publish here', async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .put(`${API}/shop/pricing`)
      .set('Authorization', bearer({ ...SUPER, perms: ['shop:pricing:write'] }))
      .send({ bwPerPage: 1.5, colorPerPage: 4 });

    expect(res.status).toBe(404);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(0);
  });

  it('a negative rate is refused', async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .put(`${API}/shop/pricing`)
      .set('Authorization', bearer(OWNER))
      .send({ bwPerPage: -1, colorPerPage: 4 });

    expect(res.status).toBe(400);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(0);
  });
});

describe('shop payout details - bank and UPI, and the account number encrypted', () => {
  const saved = env.security as { payout_encryption_key: string | null };
  let previous: string | null = null;

  beforeEach(() => {
    previous = saved.payout_encryption_key;
    saved.payout_encryption_key = KEY;
  });
  afterEach(() => {
    saved.payout_encryption_key = previous;
  });

  it('an owner saves bank details; the account number is stored encrypted and never returned', async () => {
    const db = useScriptedDb([
      ['UPDATE organizations SET', [shopRow]],
      ['FROM organizations o', [shopRow]],
    ]);

    const res = await request(app)
      .put(`${API}/shop/payout`)
      .set('Authorization', bearer(OWNER))
      .send({
        bankAccountHolder: 'Sharma Stores',
        bankName: 'HDFC Bank',
        bankAccountNumber: '123456789012',
        bankIfsc: 'hdfc0001234',
        upiId: 'sharma@hdfc',
      });

    expect(res.status).toBe(200);
    const update = db.sqlFor('UPDATE organizations SET');
    expect(update).toHaveLength(1);
    expect(update[0].sql).toContain('payout_updated_by_scope = $');
    expect(update[0].sql).toContain('bank_account_number_enc = $');

    // The digits themselves are not among the query's values; the encrypted copy is.
    const values = update[0].params.map(String);
    expect(values).not.toContain('123456789012');
    expect(values.some((v) => v.startsWith('v1:'))).toBe(true);
    expect(values).toContain('9012');
    expect(values).toContain('HDFC0001234');
    expect(values).toContain('shop');

    // The response carries the last four digits and never the number.
    expect(res.body.data.payout.bankAccountLast4).toBe('9012');
    expect(JSON.stringify(res.body)).not.toContain('123456789012');
  });

  it('refused without a key, rather than storing an account number in clear', async () => {
    saved.payout_encryption_key = null;
    const db = useScriptedDb([['UPDATE organizations SET', [shopRow]]]);

    const res = await request(app)
      .put(`${API}/shop/payout`)
      .set('Authorization', bearer(OWNER))
      .send({ bankAccountNumber: '123456789012' });

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PAYOUT_KEY_MISSING');
    expect(db.sqlFor('UPDATE organizations SET')).toHaveLength(0);
  });

  it('a manager cannot save bank details: only the owner is paid into', async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .put(`${API}/shop/payout`)
      .set('Authorization', bearer(MANAGER))
      .send({ upiId: 'sharma@hdfc' });

    expect(res.status).toBe(403);
    expect(db.sqlFor('UPDATE organizations SET')).toHaveLength(0);
  });

  it('an empty payout body is refused', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .put(`${API}/shop/payout`)
      .set('Authorization', bearer(OWNER))
      .send({});
    expect(res.status).toBe(400);
  });

  it('the platform can set a shop payout on its behalf, recorded as the platform', async () => {
    const db = useScriptedDb([['UPDATE organizations SET', [shopRow]]]);

    const res = await request(app)
      .patch(`${API}/organizations/${OWN}/payout`)
      .set('Authorization', bearer(SUPER))
      .send({ upiId: 'sharma@hdfc' });

    expect(res.status).toBe(200);
    const update = db.sqlFor('UPDATE organizations SET');
    expect(update[0].params).toContain('platform');
    expect(update[0].params).toContain('sharma@hdfc');
  });

  it("a shop cannot set another shop's payout through the platform route", async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .patch(`${API}/organizations/${OWN}/payout`)
      .set('Authorization', bearer(OWNER))
      .send({ upiId: 'sharma@hdfc' });

    expect(res.status).toBe(403);
    expect(db.sqlFor('UPDATE organizations SET')).toHaveLength(0);
  });
});

describe('shop contact details - the shop can set its own, and the platform sees who did', () => {
  it('an owner updates contact details; the change is recorded as made by the shop', async () => {
    const db = useScriptedDb([
      ['UPDATE organizations SET', [shopRow]],
      ['FROM organizations o', [shopRow]],
    ]);

    const res = await request(app)
      .put(`${API}/shop/contact`)
      .set('Authorization', bearer(OWNER))
      .send({ contactEmail: 'new@shop.com', contactPhone: '+91 98765 43210' });

    expect(res.status).toBe(200);
    const update = db.sqlFor('UPDATE organizations SET');
    expect(update[0].sql).toContain('contact_updated_at = NOW()');
    expect(update[0].params).toContain('shop');
    expect(update[0].params).toContain('new@shop.com');
  });

  it('an empty contact field is cleared, not stored as an empty string', async () => {
    const db = useScriptedDb([
      ['UPDATE organizations SET', [shopRow]],
      ['FROM organizations o', [shopRow]],
    ]);

    await request(app)
      .put(`${API}/shop/contact`)
      .set('Authorization', bearer(OWNER))
      .send({ contactPhone: '' });

    const update = db.sqlFor('UPDATE organizations SET');
    expect(update[0].params).toContain(null);
    expect(update[0].params).not.toContain('');
  });

  it('a viewer cannot change contact details', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .put(`${API}/shop/contact`)
      .set('Authorization', bearer(VIEWER))
      .send({ contactEmail: 'x@shop.test' });
    expect(res.status).toBe(403);
    expect(db.sqlFor('UPDATE organizations SET')).toHaveLength(0);
  });
});
