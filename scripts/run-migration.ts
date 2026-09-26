import { db } from '../src/config/database';
import fs from 'fs';
import path from 'path';

async function runMigration(migrationFile: string) {
  try {
    const migrationPath = path.join(__dirname, '..', 'migrations', migrationFile);
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    console.log(`Running migration: ${migrationFile}`);
    await db.query(sql);
    console.log(`✓ Migration completed: ${migrationFile}`);
  } catch (error) {
    console.error(`✗ Migration failed: ${migrationFile}`);
    console.error(error);
    process.exit(1);
  }
}

async function main() {
  const migrationFile = process.argv[2];

  if (!migrationFile) {
    console.error('Usage: npm run migrate <migration-file>');
    console.error('Example: npm run migrate 009_create_kiosks_table.sql');
    process.exit(1);
  }

  await runMigration(migrationFile);
  process.exit(0);
}

main();
