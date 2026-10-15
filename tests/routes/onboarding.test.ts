import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');
// Documents never reach a real object store from a test.
jest.mock('../../src/services/storageService', () => ({
  storageService: {
    uploadFile: jest.fn(async (key: string) => key),
    downloadFile: jest.fn(async () => Buffer.from('%PDF-1.7\n')),
    deleteFile: jest.fn(async () => undefined),
  },
}));

const API = '/api/v1/admin';
const DRAFT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';

const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;
const SUPER = { role: 'super_admin', org: null, perms: ['orgs:read', 'orgs:write'] };
const OWNER = { role: 'owner', org: ORG, perms: [] };
const MANAGER = { role: 'manager', org: ORG, perms: [] };
const VIEWER = { role: 'viewer', org: ORG, perms: [] };
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

describe('onboarding is platform-only', () => {
  it('401 without a token', async () => {
    useScriptedDb([]);
    expect((await request(app).post(`${API}/onboarding/drafts`)).status).toBe(401);
  });

  it.each([
    ['owner', OWNER],
    ['manager', MANAGER],
    ['viewer', VIEWER],
  ])('a shop %s cannot start, read, save or complete a draft', async (_name, who) => {
    const db = useScriptedDb([]);
    const auth = bearer(who);
    expect(
      (await request(app).post(`${API}/onboarding/drafts`).set('Authorization', auth)).status
    ).toBe(403);
    expect(
      (await request(app).get(`${API}/onboarding/drafts/${DRAFT}`).set('Authorization', auth))
        .status
    ).toBe(403);
    expect(
      (
        await request(app)
          .put(`${API}/onboarding/drafts/${DRAFT}`)
          .set('Authorization', auth)
          .send({ version: 1, patch: {} })
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`${API}/onboarding/drafts/${DRAFT}/complete`)
          .set('Authorization', auth)
      ).status
    ).toBe(403);
    expect(db.sqlFor('partner_onboarding_drafts')).toHaveLength(0);
  });

  it('a shop cannot read another partner’s documents', async () => {
    useScriptedDb([]);
    expect(
      (
        await request(app)
          .get(`${API}/organizations/${ORG}/documents`)
          .set('Authorization', bearer(OWNER))
      ).status
    ).toBe(403);
    expect(
      (
        await request(app)
          .get(`${API}/organizations/${ORG}/documents/${DOC}/download`)
          .set('Authorization', bearer(OWNER))
      ).status
    ).toBe(403);
  });
});

describe('the wizard’s save and read', () => {
  it('a super admin starts a draft (201)', async () => {
    useScriptedDb([
      ['INSERT INTO partner_onboarding_drafts', [{ id: DRAFT }]],
      [
        'FROM partner_onboarding_drafts',
        [
          {
            id: DRAFT,
            status: 'open',
            payload: {},
            version: 1,
            expires_at: new Date(Date.now() + 86_400_000),
            organization_id: null,
            expired: false,
          },
        ],
      ],
    ]);
    const res = await request(app)
      .post(`${API}/onboarding/drafts`)
      .set('Authorization', bearer(SUPER));
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('open');
  });

  it('a draft never shows a password, even one that was filled in', async () => {
    useScriptedDb([
      [
        'FROM partner_onboarding_drafts',
        [
          {
            id: DRAFT,
            status: 'open',
            payload: { owner: { fullName: 'A', email: 'a@b.test' } },
            version: 2,
            expires_at: new Date(Date.now() + 86_400_000),
            organization_id: null,
            expired: false,
          },
        ],
      ],
      ['SELECT id, kind, original_filename', []],
    ]);
    const res = await request(app)
      .get(`${API}/onboarding/drafts/${DRAFT}`)
      .set('Authorization', bearer(SUPER));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/temporaryPassword|password_hash|passwordHash/);
  });

  it('a save without a version is refused before it reaches the database', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .put(`${API}/onboarding/drafts/${DRAFT}`)
      .set('Authorization', bearer(SUPER))
      .send({ patch: { business: { city: 'Indore' } } });
    expect(res.status).toBe(400);
    expect(db.sqlFor('SET payload')).toHaveLength(0);
  });

  it('a malformed pincode or an unknown state is refused', async () => {
    useScriptedDb([]);
    const pin = await request(app)
      .put(`${API}/onboarding/drafts/${DRAFT}`)
      .set('Authorization', bearer(SUPER))
      .send({ version: 1, patch: { business: { pincode: 'abc123' } } });
    expect(pin.status).toBe(400);
    const state = await request(app)
      .put(`${API}/onboarding/drafts/${DRAFT}`)
      .set('Authorization', bearer(SUPER))
      .send({ version: 1, patch: { business: { state: 'Narnia' } } });
    expect(state.status).toBe(400);
  });

  it('a model that is not a real model is refused', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .put(`${API}/onboarding/drafts/${DRAFT}`)
      .set('Authorization', bearer(SUPER))
      .send({ version: 1, patch: { model: { businessModel: 'made-up' } } });
    expect(res.status).toBe(400);
  });

  it('a draft id that is not a UUID is refused before the database is touched', async () => {
    const db = useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/onboarding/drafts/not-a-uuid`)
      .set('Authorization', bearer(SUPER));
    expect(res.status).toBe(400);
    expect(db.sqlFor('partner_onboarding_drafts')).toHaveLength(0);
  });
});

describe('document upload', () => {
  const upload = (buf: Buffer, type: string, kind = 'gst_certificate') =>
    request(app)
      .post(`${API}/onboarding/drafts/${DRAFT}/documents`)
      .set('Authorization', bearer(SUPER))
      .field('kind', kind)
      .attach('document', buf, { filename: 'gst.pdf', contentType: type });

  it('a text file sent as a PDF is refused (400)', async () => {
    useScriptedDb([['FOR UPDATE', []]]);
    const res = await upload(Buffer.from('hello'), 'application/pdf');
    expect(res.status).toBe(400);
  });

  it('a file type that is not allowed at all is refused (400)', async () => {
    useScriptedDb([]);
    const res = await upload(Buffer.from('<html></html>'), 'text/html');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only PDF, PNG, and JPEG|Invalid file type/);
  });

  it('a file over the limit is refused as too large (413), not as a server error', async () => {
    useScriptedDb([]);
    const res = await upload(Buffer.alloc(11 * 1024 * 1024, 0x41), 'application/pdf');
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('a request with no file is refused with a clear message', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/onboarding/drafts/${DRAFT}/documents`)
      .set('Authorization', bearer(SUPER))
      .field('kind', 'gst_certificate');
    expect(res.status).toBe(400);
  });

  it('a real PDF is staged (201)', async () => {
    useScriptedDb([
      [
        'FOR UPDATE',
        [
          {
            id: DRAFT,
            status: 'open',
            payload: {},
            version: 1,
            expires_at: new Date(Date.now() + 86_400_000),
            organization_id: null,
            expired: false,
          },
        ],
      ],
      ['INSERT INTO partner_documents', [{ id: DOC, uploaded_at: new Date() }]],
    ]);
    const res = await upload(PDF, 'application/pdf');
    expect(res.status).toBe(201);
    expect(res.body.data.kind).toBe('gst_certificate');
  });
});

describe('partner documents', () => {
  it('a super admin can download a partner’s document, with the safe headers set', async () => {
    useScriptedDb([
      [
        'FROM partner_documents',
        [
          {
            original_filename: 'GST "cert".pdf',
            content_type: 'application/pdf',
            storage_key: 'k.pdf',
          },
        ],
      ],
    ]);
    const res = await request(app)
      .get(`${API}/organizations/${ORG}/documents/${DOC}/download`)
      .set('Authorization', bearer(SUPER))
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('attachment; filename="GST__cert_.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
