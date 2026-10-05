import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { db } from '../../src/config/database';
import env from '../../src/config/environment';
import { Rule, scriptedDb, ScriptedDb } from './fakeDb';

export const sha256 = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

/** Points the (jest.mock'ed) shared db at a scripted fake. */
export function useScriptedDb(rules: Rule[]): ScriptedDb {
  const fake = scriptedDb(rules);
  const mocked = db as jest.Mocked<typeof db>;
  mocked.query.mockImplementation(fake.query as never);
  (mocked.getClient as jest.Mock).mockImplementation(fake.getClient);
  return fake;
}

/** A session credential row as SessionAccessService reads it. */
export const sessionRule = (token: string | null, sessionId = 'S1'): Rule => [
  'ps.access_token_hash',
  [{ id: 'ps-1', session_id: sessionId, access_token_hash: token ? sha256(token) : null }],
];

export function adminToken(over: Record<string, unknown> = {}): string {
  return jwt.sign(
    {
      sub: 'admin-1',
      email: 'a@example.test',
      role: 'super_admin',
      org: null,
      perms: [],
      typ: 'admin_access',
      ...over,
    },
    env.jwt.secret,
    { expiresIn: '5m' }
  );
}
