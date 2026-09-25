/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create admin_users table
  pgm.createTable('admin_users', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    email: {
      type: 'varchar(255)',
      notNull: true,
      unique: true,
    },
    password_hash: {
      type: 'text',
      notNull: true,
    },
    full_name: {
      type: 'varchar(255)',
    },
    role: {
      type: 'varchar(20)',
      default: "'viewer'",
    },
    last_login_at: {
      type: 'timestamp',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    is_active: {
      type: 'boolean',
      default: true,
    },
    failed_login_attempts: {
      type: 'integer',
      default: 0,
    },
    locked_until: {
      type: 'timestamp',
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE admin_users IS 'Admin dashboard users with RBAC'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('admin_users');
}
