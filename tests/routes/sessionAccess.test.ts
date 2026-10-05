import request from 'supertest';
import app from '../../src/app';
import { adminToken, sessionRule, sha256, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');
jest.mock('../../src/services/storageService', () => ({
  storageService: { getPresignedUrl: jest.fn().mockResolvedValue('https://s3.test/x') },
}));

const API = '/api/v1';
const JOB = '44444444-4444-4444-8444-444444444444';
const DOC = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'a'.repeat(64);

const jobRow = {
  id: JOB,
  session_id: 'ps-1',
  document_id: DOC,
  kiosk_id: 'k1',
  status: 'pending',
  total_amount: '10.00',
  base_price_per_page: '5.00',
};

describe('customer routes require the session token', () => {
  it('POST /sessions returns a token and stores only its hash', async () => {
    const db = useScriptedDb([
      [
        'FROM kiosks WHERE kiosk_id',
        [{ id: 'k1', kiosk_id: 'M001', status: 'active', location: 'L', capabilities: {} }],
      ],
      [
        'INSERT INTO print_sessions',
        [{ id: 'ps-1', session_id: 'S1', status: 'draft', expires_at: new Date() }],
      ],
    ]);

    const res = await request(app).post(`${API}/sessions`).send({ kioskId: 'M001' });

    expect(res.status).toBe(201);
    const token = res.body.data.sessionToken as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const insert = db.sqlFor('INSERT INTO print_sessions')[0];
    expect(insert.params).toContain(sha256(token));
    expect(insert.params).not.toContain(token);
  });

  it('401 SESSION_TOKEN_REQUIRED without the header', async () => {
    useScriptedDb([sessionRule(TOKEN)]);
    const res = await request(app).get(`${API}/print-jobs/${JOB}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_TOKEN_REQUIRED');
  });

  it('403 SESSION_TOKEN_INVALID with a wrong token', async () => {
    useScriptedDb([sessionRule(TOKEN)]);
    const res = await request(app)
      .get(`${API}/print-jobs/${JOB}`)
      .set('X-Session-Token', 'b'.repeat(64));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SESSION_TOKEN_INVALID');
  });

  it('403 for a session created before tokens existed', async () => {
    useScriptedDb([sessionRule(null)]);
    const res = await request(app).get(`${API}/print-jobs/${JOB}`).set('X-Session-Token', TOKEN);
    expect(res.status).toBe(403);
  });

  it('200 with the right token', async () => {
    useScriptedDb([sessionRule(TOKEN), ['FROM print_jobs WHERE id', [jobRow]]]);
    const res = await request(app).get(`${API}/print-jobs/${JOB}`).set('X-Session-Token', TOKEN);
    expect(res.status).toBe(200);
  });

  it('passes through to the route 404 when the job does not exist', async () => {
    useScriptedDb([]);
    const res = await request(app).get(`${API}/print-jobs/${JOB}`).set('X-Session-Token', TOKEN);
    expect(res.status).toBe(404);
  });

  it("refuses another session's document (ownership)", async () => {
    // The document belongs to a session whose token is TOKEN; caller holds another.
    useScriptedDb([sessionRule(TOKEN), ['FROM documents WHERE id', [{ id: DOC, s3_key: 'k' }]]]);

    for (const path of ['', '/preview', '/download']) {
      const res = await request(app)
        .get(`${API}/documents/${DOC}${path}`)
        .set('X-Session-Token', 'c'.repeat(64));
      expect(res.status).toBe(403);
    }
    const del = await request(app)
      .delete(`${API}/documents/${DOC}`)
      .set('X-Session-Token', 'c'.repeat(64));
    expect(del.status).toBe(403);
  });

  it('guards session, upload, job-list, payment and queue routes', async () => {
    useScriptedDb([sessionRule(TOKEN)]);
    const routes: Array<[string, string]> = [
      ['get', `${API}/sessions/S1`],
      ['delete', `${API}/sessions/S1`],
      ['post', `${API}/sessions/S1/documents`],
      ['get', `${API}/sessions/S1/documents`],
      ['post', `${API}/sessions/S1/print-jobs`],
      ['get', `${API}/sessions/S1/print-jobs`],
      ['patch', `${API}/print-jobs/${JOB}/settings`],
      ['post', `${API}/print-jobs/${JOB}/payment/order`],
      ['get', `${API}/print-jobs/${JOB}/payment`],
      ['get', `${API}/payment/order/order_1`],
      ['get', `${API}/payment/order/order_1/status`],
      ['get', `${API}/queue/jobs/${JOB}`],
    ];
    for (const [method, path] of routes) {
      const res = await (request(app) as any)[method](path).send({ copies: 1 });
      expect([method, path, res.status]).toEqual([method, path, 401]);
    }
  });
});

describe('closed public listings', () => {
  it('GET /sessions needs an admin token', async () => {
    useScriptedDb([]);
    expect((await request(app).get(`${API}/sessions`)).status).toBe(401);
  });

  it('GET /sessions refuses shop staff', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/sessions`)
      .set('Authorization', `Bearer ${adminToken({ role: 'owner', org: 'org-1' })}`);
    expect(res.status).toBe(403);
  });

  it('GET /sessions works for a super admin', async () => {
    useScriptedDb([
      ['COUNT(*) as total', [{ total: '0' }]],
      ['COUNT(*) FILTER', [{ active: '0', expired: '0' }]],
    ]);
    const res = await request(app)
      .get(`${API}/sessions`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it('GET /setup/kiosks returns only safe fields', async () => {
    const db = useScriptedDb([
      [
        'FROM kiosks',
        [
          {
            kiosk_id: 'M001',
            name: 'Lib',
            location: 'Ground',
            status: 'active',
            capabilities: { color: true },
          },
        ],
      ],
    ]);
    const res = await request(app).get(`${API}/setup/kiosks`);
    expect(res.status).toBe(200);
    expect(res.body.data.kiosks).toEqual([
      {
        kioskId: 'M001',
        name: 'Lib',
        location: 'Ground',
        status: 'active',
        capabilities: { color: true },
      },
    ]);
    expect(db.calls[0].sql).not.toContain('SELECT *');
  });
});

describe('print-job routes are mounted once', () => {
  it.each([`${API}/sessions/print-jobs/${JOB}`, `${API}/S1/print-jobs`])(
    'no shadow path %s',
    async (path) => {
      useScriptedDb([sessionRule(TOKEN), ['FROM print_jobs WHERE id', [jobRow]]]);
      const res = await request(app).get(path).set('X-Session-Token', TOKEN);
      expect(res.status).toBe(404);
      expect(res.body.message).toMatch(/^Route .* not found$/);
    }
  );
});
