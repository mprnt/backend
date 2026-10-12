import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';
import { Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const API = '/api/v1/admin';
const OWN = '11111111-1111-4111-8111-111111111111';
const OTHER = '55555555-5555-4555-8555-555555555555';
const KIOSK = '22222222-2222-4222-8222-222222222222';

const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;
const SHOP_OWNER = { role: 'owner', org: OWN, perms: ['split:read'] };
const SUPER = { role: 'super_admin', org: null, perms: ['split:read', 'split:write'] };

const termRows = [
  {
    id: 'T-PARTNER',
    kiosk_id: null,
    kiosk_name: null,
    partner_share_pct: '30',
    effective_from: new Date('2026-09-01T00:00:00Z'),
    note: 'Agreement signed',
    created_at: new Date('2026-09-01T00:00:00Z'),
    created_by_email: 'root@mprnt.test',
  },
];

const orgRule = (model: string | null): Rule => [
  'FROM organizations WHERE id',
  [{ business_model: model }],
];

describe('GET /admin/revenue-split - a partner reads its own split', () => {
  it('401 without a token', async () => {
    useScriptedDb([]);
    expect((await request(app).get(`${API}/revenue-split`)).status).toBe(401);
  });

  it('403 for shop staff without split:read', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/revenue-split`)
      .set('Authorization', bearer({ role: 'owner', org: OWN, perms: [] }));
    expect(res.status).toBe(403);
  });

  it('returns the partner split, and hides the name of whoever set it', async () => {
    useScriptedDb([
      orgRule('revenue-share'),
      ['FROM kiosks WHERE organization_id', [{ id: KIOSK, name: 'QR-1' }]],
      ['FROM revenue_split_terms t', termRows],
    ]);

    const res = await request(app)
      .get(`${API}/revenue-split`)
      .set('Authorization', bearer(SHOP_OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data.applies).toBe(true);
    expect(res.body.data.partnerDefault).toMatchObject({
      partnerSharePct: 30,
      platformSharePct: 70,
    });
    expect(res.body.data.byQrPoint[0]).toMatchObject({
      kioskName: 'QR-1',
      partnerSharePct: 30,
      source: 'partner',
    });
    expect(res.body.data.history[0]).not.toHaveProperty('createdBy');
    expect(JSON.stringify(res.body)).not.toContain('root@mprnt.test');
  });

  it("a shop cannot read another partner's split by naming it", async () => {
    // resolveTenant answers "not found" rather than "forbidden", so a shop
    // cannot use the endpoint to discover which partners exist.
    useScriptedDb([orgRule('revenue-share'), ['FROM revenue_split_terms t', termRows]]);
    const res = await request(app)
      .get(`${API}/revenue-split?organizationId=${OTHER}`)
      .set('Authorization', bearer(SHOP_OWNER));
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  it('a super admin names the partner and sees the author', async () => {
    useScriptedDb([
      orgRule('revenue-share'),
      ['FROM kiosks WHERE organization_id', []],
      ['FROM revenue_split_terms t', termRows],
    ]);

    const res = await request(app)
      .get(`${API}/revenue-split?organizationId=${OWN}`)
      .set('Authorization', bearer(SUPER));

    expect(res.status).toBe(200);
    expect(res.body.data.history[0].createdBy).toBe('root@mprnt.test');
  });

  it('a super admin must say which partner it is for', async () => {
    useScriptedDb([]);
    const res = await request(app).get(`${API}/revenue-split`).set('Authorization', bearer(SUPER));
    expect(res.status).toBe(400);
  });
});

describe('GET /admin/revenue-split/summary', () => {
  it('a shop sees its own share of the period', async () => {
    const db = useScriptedDb([
      ['FROM organizations WHERE id', [{ timezone: 'Asia/Kolkata' }]],
      ['to_char(date_trunc', [{ start_date: '2026-10-01', end_date: '2026-10-13' }]],
      [
        'AS paid_jobs',
        [
          {
            paid_jobs: '4',
            split_jobs: '4',
            gross: '100',
            partner: '30',
            platform: '70',
            unsplit: '0',
          },
        ],
      ],
    ]);

    const res = await request(app)
      .get(`${API}/revenue-split/summary?period=month`)
      .set('Authorization', bearer(SHOP_OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      grossRevenue: 100,
      partnerRevenue: 30,
      platformRevenue: 70,
      unsplitRevenue: 0,
    });
    const summary = db.sqlFor('AS paid_jobs');
    expect(summary[0].params).toContain(OWN);
  });

  it('rejects an unknown period', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/revenue-split/summary?period=decade`)
      .set('Authorization', bearer(SHOP_OWNER));
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/revenue-split - platform only', () => {
  const body = { organizationId: OWN, partnerSharePct: 30, note: 'Agreement signed' };

  it('403 for a shop owner, even one holding split:write, so a partner cannot set its own split', async () => {
    const db = useScriptedDb([orgRule('revenue-share')]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer({ role: 'owner', org: OWN, perms: ['split:write'] }))
      .send({ ...body, partnerSharePct: 99 });
    expect(res.status).toBe(403);
    expect(db.sqlFor('INSERT INTO revenue_split_terms')).toHaveLength(0);
  });

  it('409 when the partner is not on Option A', async () => {
    const db = useScriptedDb([orgRule('integration')]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send(body);
    expect(res.status).toBe(409);
    expect(res.body.code ?? res.body.error?.code).toBe('NOT_REVENUE_SHARE');
    expect(db.sqlFor('INSERT INTO revenue_split_terms')).toHaveLength(0);
  });

  it('400 for a share outside 0 to 100', async () => {
    useScriptedDb([orgRule('revenue-share')]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send({ ...body, partnerSharePct: 120 });
    expect(res.status).toBe(400);
  });

  it('400 without a note: a commercial term needs a recorded reason', async () => {
    useScriptedDb([orgRule('revenue-share')]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send({ organizationId: OWN, partnerSharePct: 30 });
    expect(res.status).toBe(400);
  });

  it('400 for a term that would start in the past', async () => {
    const db = useScriptedDb([orgRule('revenue-share')]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send({ ...body, effectiveFrom: '2020-01-01T00:00:00Z' });
    expect(res.status).toBe(400);
    expect(db.sqlFor('INSERT INTO revenue_split_terms')).toHaveLength(0);
  });

  it('400 for a QR point that belongs to another partner', async () => {
    useScriptedDb([
      orgRule('revenue-share'),
      ['FROM kiosks WHERE id', [{ organization_id: OTHER }]],
    ]);
    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send({ ...body, kioskId: KIOSK });
    expect(res.status).toBe(400);
  });

  it('a super admin records the term, with the note and the author', async () => {
    const db = useScriptedDb([
      orgRule('revenue-share'),
      ['FROM revenue_split_terms t', termRows],
      [
        'INSERT INTO revenue_split_terms',
        [{ id: 'T-NEW', effective_from: new Date('2026-10-12T06:00:00Z') }],
      ],
    ]);

    const res = await request(app)
      .post(`${API}/revenue-split`)
      .set('Authorization', bearer(SUPER))
      .send({ ...body, partnerSharePct: 35.5, note: '  Renewed for FY27  ' });

    expect(res.status).toBe(201);
    expect(res.body.data.id).toBe('T-NEW');
    const insert = db.sqlFor('INSERT INTO revenue_split_terms')[0];
    expect(insert.params).toEqual([OWN, null, 35.5, null, 'Renewed for FY27', expect.any(String)]);
    expect(db.sqlFor('INSERT INTO audit_logs').length).toBeGreaterThan(0);
  });
});
