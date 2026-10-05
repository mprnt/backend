/**
 * A scripted stand-in for Postgres. Each rule maps a SQL fragment to the rows
 * the statement returns; the first matching rule wins and unmatched statements
 * return no rows. Every statement is recorded, so tests can assert on what was
 * (or was not) written.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Rows = any[] | ((params: any[]) => any[]);
export type Rule = [fragment: string, rows: Rows];

export const result = (rows: any[]) => ({
  rows,
  command: 'SELECT',
  rowCount: rows.length,
  oid: 0,
  fields: [],
});

export function scriptedDb(rules: Rule[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let current = [...rules];

  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql: String(sql), params });
    const rule = current.find(([fragment]) => String(sql).includes(fragment));
    if (!rule) return result([]);
    const rows = typeof rule[1] === 'function' ? rule[1](params) : rule[1];
    return result(rows);
  });

  const client = { query, release: jest.fn() };

  return {
    query,
    client,
    getClient: jest.fn(async () => client),
    calls,
    /** Replace the rules (keeps the call log). */
    setRules(next: Rule[]) {
      current = [...next];
    },
    /** Statements containing a fragment, in order. */
    sqlFor(fragment: string) {
      return calls.filter((c) => c.sql.includes(fragment));
    },
  };
}

export type ScriptedDb = ReturnType<typeof scriptedDb>;
