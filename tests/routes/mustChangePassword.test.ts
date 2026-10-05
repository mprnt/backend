import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import app from '../../src/app';
import { adminAuthService } from '../../src/services/adminAuthService';
import { adminToken, useScriptedDb } from '../helpers/http';

jest.mock('../../src/config/database');

const API = '/api/v1';
const temp = (over: Record<string, unknown> = {}) => `Bearer ${adminToken({ mcp: true, ...over })}`;

describe('admin with a temporary password (mustChangePassword)', () => {
  it('403 PASSWORD_CHANGE_REQUIRED on ordinary admin routes', async () => {
    useScriptedDb([]);
    for (const [method, path] of [
      ['get', '/admin/permissions'],
      ['get', '/admin/leads'],
      ['get', '/admin/organizations'],
      ['post', '/admin/print-jobs/88888888-8888-4888-8888-888888888888/refund'],
      ['get', '/sessions'],
    ] as const) {
      const res = await request(app)[method](`${API}${path}`).set('Authorization', temp());
      expect({ path, status: res.status, code: res.body.code }).toEqual({
        path,
        status: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
  });

  it('can still read auth/me', async () => {
    useScriptedDb([]);
    const res = await request(app).get(`${API}/admin/auth/me`).set('Authorization', temp());
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe('admin-1');
  });

  it('can still change the password', async () => {
    const hash = await bcrypt.hash('Temporary-pass-1', 4);
    const db = useScriptedDb([
      ['SELECT password_hash FROM admin_users', [{ password_hash: hash }]],
    ]);
    const res = await request(app)
      .post(`${API}/admin/auth/change-password`)
      .set('Authorization', temp())
      .send({ currentPassword: 'Temporary-pass-1', newPassword: 'A-much-better-pass-2' });
    expect(res.status).toBe(200);
    expect(db.sqlFor('must_change_password = false')).toHaveLength(1);
  });

  it('a wrong current password is 400 INVALID_CURRENT_PASSWORD, not 401', async () => {
    const hash = await bcrypt.hash('Temporary-pass-1', 4);
    const db = useScriptedDb([
      ['SELECT password_hash FROM admin_users', [{ password_hash: hash }]],
    ]);
    const res = await request(app)
      .post(`${API}/admin/auth/change-password`)
      .set('Authorization', temp())
      .send({ currentPassword: 'Wrong-pass-123', newPassword: 'A-much-better-pass-2' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(db.sqlFor('must_change_password = false')).toHaveLength(0);
  });

  it('can still log out (public route)', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .post(`${API}/admin/auth/logout`)
      .set('Authorization', temp())
      .send({ refreshToken: 'x'.repeat(64) });
    expect(res.status).not.toBe(403);
  });

  it('an admin without the flag is not blocked', async () => {
    useScriptedDb([]);
    const res = await request(app)
      .get(`${API}/admin/permissions`)
      .set('Authorization', `Bearer ${adminToken()}`);
    expect(res.status).toBe(200);
  });

  it('the flag travels in the access token and refresh re-reads it from the database', async () => {
    expect(adminAuthService.verifyAccessToken(adminToken({ mcp: true })).mustChangePassword).toBe(
      true
    );
    expect(adminAuthService.verifyAccessToken(adminToken()).mustChangePassword).toBe(false);

    useScriptedDb([
      [
        'FROM admin_refresh_tokens rt',
        [
          {
            token_id: 't-1',
            admin_user_id: 'admin-2',
            revoked_at: null,
            is_expired: false,
            id: 'admin-2',
            email: 'owner@example.com',
            role: 'owner',
            organization_id: 'org-1',
            is_active: true,
            must_change_password: true,
            deleted_at: null,
            org_status: 'active',
          },
        ],
      ],
    ]);
    const { accessToken } = await adminAuthService.refresh('r'.repeat(64));
    expect((jwt.decode(accessToken) as { mcp?: boolean }).mcp).toBe(true);
  });
});
