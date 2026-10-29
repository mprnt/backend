import request from 'supertest';
import app from '../../src/app';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');

const API = '/api/v1/admin';
const bearer = (over: Record<string, unknown>) => `Bearer ${adminToken(over)}`;
const SUPER = { role: 'super_admin', org: null, perms: ['orgs:read'] };

const row = {
  id: 'd-1',
  payload: {
    business: { tradingName: 'Sharma Stores', city: 'Indore' },
    owner: { email: 'owner@sharma.com' },
    qrPoint: { code: 'SH01' },
    payout: { upiId: 'sharma@hdfc', bankAccountLast4: '9012', bankAccountNumberEnc: 'v1:secret' },
  },
  created_at: new Date('2026-10-20T10:00:00Z'),
  updated_at: new Date('2026-10-21T10:00:00Z'),
  expires_at: new Date('2026-10-27T10:00:00Z'),
  created_by_email: 'ops@mprnt.in',
  documents: '2',
};

describe('GET /admin/onboarding/drafts - partners still being onboarded', () => {
  it('lists open drafts with how far each has got', async () => {
    const db = useScriptedDb([['FROM partner_onboarding_drafts d', [row]]]);

    const res = await request(app)
      .get(`${API}/onboarding/drafts`)
      .set('Authorization', bearer(SUPER));

    expect(res.status).toBe(200);
    expect(db.sqlFor('FROM partner_onboarding_drafts d')[0].sql).toContain("d.status = 'open'");
    expect(res.body.data.drafts[0]).toEqual({
      id: 'd-1',
      tradingName: 'Sharma Stores',
      city: 'Indore',
      ownerEmail: 'owner@sharma.com',
      qrCode: 'SH01',
      steps: { business: true, qrPoint: true, owner: true, payout: true },
      documents: 2,
      createdBy: 'ops@mprnt.in',
      createdAt: '2026-10-20T10:00:00.000Z',
      updatedAt: '2026-10-21T10:00:00.000Z',
      expiresAt: '2026-10-27T10:00:00.000Z',
    });
  });

  it('never returns payout details, not even the encrypted account number', async () => {
    useScriptedDb([['FROM partner_onboarding_drafts d', [row]]]);
    const res = await request(app)
      .get(`${API}/onboarding/drafts`)
      .set('Authorization', bearer(SUPER));
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('v1:secret');
    expect(text).not.toContain('sharma@hdfc');
    expect(text).not.toContain('9012');
  });

  it('is for the platform only', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/onboarding/drafts`)
      .set('Authorization', bearer({ role: 'owner', org: 'org-1', perms: ['orgs:read'] }));
    expect(res.status).toBe(403);
  });
});
