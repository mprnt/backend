import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');

const API = '/api/v1/admin';
const OWN = 'org-own';
const OTHER = '22222222-2222-4222-8222-222222222222';

const OWNER = { role: 'owner', org: OWN, perms: ['reports:read'] };
const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;

const shopRow = {
  name: 'Shop 1',
  status: 'active',
  timezone: 'Asia/Kolkata',
  contact_email: 'owner@shop.test',
  contact_phone: null,
  member_since: '2026-09-28T12:57:12Z',
  qr_points: '1',
  printers: '2',
  stations: '1',
  revenue: '506.004',
  paid_jobs: '24',
  completed_jobs: '21',
  pages_printed: '161',
  first_sale_at: '2026-09-30T10:00:00Z',
};

describe('GET /admin/shop - a shop reads only its own profile', () => {
  it('401 without a token', async () => {
    useScriptedDb([]);
    expect((await request(app).get(`${API}/shop`)).status).toBe(401);
  });

  it("returns the caller's shop, shaped for the shop and nothing more", async () => {
    useScriptedDb([['FROM organizations o', [shopRow]]]);

    const res = await request(app).get(`${API}/shop`).set('Authorization', bearer(OWNER));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      name: 'Shop 1',
      status: 'active',
      timezone: 'Asia/Kolkata',
      contactEmail: 'owner@shop.test',
      contactPhone: null,
      memberSince: '2026-09-28T12:57:12Z',
      fleet: { qrPoints: 1, printers: 2, stations: 1 },
      lifetime: {
        revenue: 506,
        paidJobs: 24,
        completedJobs: 21,
        pagesPrinted: 161,
        firstSaleAt: '2026-09-30T10:00:00Z',
      },
    });

    // No internal identifiers, no slug, no commercial model, no notes.
    for (const key of [
      'id',
      'slug',
      'businessModel',
      'business_model',
      'notes',
      'organizationId',
    ]) {
      expect(res.body.data).not.toHaveProperty(key);
    }
  });

  it("binds the query to the token's organization", async () => {
    const db = useScriptedDb([['FROM organizations o', [shopRow]]]);

    await request(app).get(`${API}/shop`).set('Authorization', bearer(OWNER));

    const calls = db.sqlFor('FROM organizations o');
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([OWN]);
  });

  it('ignores an organizationId in the query string', async () => {
    const db = useScriptedDb([['FROM organizations o', [shopRow]]]);

    const res = await request(app)
      .get(`${API}/shop?organizationId=${OTHER}`)
      .set('Authorization', bearer(OWNER));

    expect(res.status).toBe(200);
    expect(db.sqlFor('FROM organizations o')[0].params).toEqual([OWN]);
  });

  it('403 for an account without reports:read', async () => {
    useScriptedDb([['FROM organizations o', [shopRow]]]);
    const res = await request(app)
      .get(`${API}/shop`)
      .set('Authorization', bearer({ role: 'viewer', org: OWN, perms: [] }));
    expect(res.status).toBe(403);
  });

  it('404 for a platform account, which has no shop', async () => {
    useScriptedDb([['FROM organizations o', [shopRow]]]);
    const res = await request(app)
      .get(`${API}/shop`)
      .set('Authorization', bearer({ role: 'super_admin', org: null, perms: ['reports:read'] }));
    expect(res.status).toBe(404);
  });

  it('404 when the shop no longer exists', async () => {
    useScriptedDb([['FROM organizations o', []]]);
    const res = await request(app).get(`${API}/shop`).set('Authorization', bearer(OWNER));
    expect(res.status).toBe(404);
  });
});

describe('POST /admin/pricing/lists - platform only', () => {
  const body = { organizationId: OTHER, bwPerPage: 0.01, colorPerPage: 0.01 };

  it('403 for shop staff who hold pricing:write', async () => {
    // No shop role carries the permission and the API will not grant it, but a
    // database-level override could. The route must not depend on that staying
    // true, because the handler takes organizationId from the body unchecked.
    const db = useScriptedDb([]);

    const res = await request(app)
      .post(`${API}/pricing/lists`)
      .set('Authorization', bearer({ role: 'owner', org: OWN, perms: ['pricing:write'] }))
      .send(body);

    expect(res.status).toBe(403);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(0);
  });

  it('403 for shop staff publishing platform-wide rates', async () => {
    const db = useScriptedDb([]);

    const res = await request(app)
      .post(`${API}/pricing/lists`)
      .set('Authorization', bearer({ role: 'manager', org: OWN, perms: ['pricing:write'] }))
      .send({ bwPerPage: 0.01, colorPerPage: 0.01 });

    expect(res.status).toBe(403);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(0);
  });

  it('a super admin can still publish', async () => {
    const db = useScriptedDb([
      [
        'INSERT INTO price_lists',
        [{ id: 'pl-1', bw_per_page: '2', color_per_page: '5', min_charge: '0' }],
      ],
    ]);

    const res = await request(app)
      .post(`${API}/pricing/lists`)
      .set('Authorization', bearer({ role: 'super_admin', org: null, perms: ['pricing:write'] }))
      .send(body);

    expect(res.status).toBe(201);
    expect(db.sqlFor('INSERT INTO price_lists')).toHaveLength(1);
  });
});
