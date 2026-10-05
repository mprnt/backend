import fs from 'fs';
import path from 'path';
import env from '../src/config/environment';
import { db } from '../src/config/database';

/**
 * Runs one SQL migration from migrations/.
 *
 *   npm run migrate:sql -- 014_super_admin_ops.sql
 *   DATABASE_URL="postgresql://…" npm run migrate:sql -- 014_super_admin_ops.sql --yes
 *
 * The target database comes from DATABASE_URL, which .env supplies when it is
 * not set in the shell. That default once sent a production migration to a
 * developer's local database: it printed "✓ Migration completed", production
 * was untouched, and the deploy that relied on it broke.
 *
 * So the script now says exactly which database it is about to change, and
 * refuses anything that is not local unless `--yes` confirms it was intended.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function describeTarget(): { host: string; label: string } {
  if (env.database.url) {
    try {
      const u = new URL(env.database.url);
      return {
        host: u.hostname,
        label: `${u.hostname}:${u.port || '5432'}${u.pathname} (user ${decodeURIComponent(u.username) || '?'})`,
      };
    } catch {
      return { host: 'unparseable DATABASE_URL', label: 'unparseable DATABASE_URL' };
    }
  }
  return {
    host: env.database.host,
    label: `${env.database.host}:${env.database.port}/${env.database.name} (user ${env.database.user})`,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const migrationFile = args.find((a) => !a.startsWith('--'));

  if (!migrationFile) {
    console.error('Usage: npm run migrate:sql -- <migration-file> [--yes]');
    console.error('Example: npm run migrate:sql -- 014_super_admin_ops.sql');
    process.exit(1);
  }

  const migrationPath = path.join(__dirname, '..', 'migrations', migrationFile);
  if (!fs.existsSync(migrationPath)) {
    console.error(`✗ No such migration: migrations/${migrationFile}`);
    process.exit(1);
  }

  const target = describeTarget();
  const local = LOCAL_HOSTS.has(target.host);

  console.log(`Target database: ${target.label}${local ? '  [local]' : '  [REMOTE]'}`);

  if (!local && !confirmed) {
    console.error(
      '\n✗ Refusing to migrate a remote database without confirmation.\n' +
        '  Check the target above, then re-run with --yes.'
    );
    process.exit(1);
  }

  try {
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    console.log(`Running migration: ${migrationFile}`);
    await db.query(sql);
    console.log(`✓ Migration completed: ${migrationFile} on ${target.label}`);
  } catch (error) {
    console.error(`✗ Migration failed: ${migrationFile}`);
    console.error(error);
    process.exit(1);
  }

  process.exit(0);
}

void main();
