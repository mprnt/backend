/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create print_sessions table
  pgm.createTable('print_sessions', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    session_id: {
      type: 'varchar(20)',
      notNull: true,
      unique: true,
    },
    kiosk_id: {
      type: 'uuid',
      references: 'kiosks(id)',
    },
    status: {
      type: 'varchar(20)',
      default: "'draft'",
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    expires_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP + INTERVAL '15 minutes'"),
    },
    completed_at: {
      type: 'timestamp',
    },
    client_ip: {
      type: 'inet',
    },
    user_agent: {
      type: 'text',
    },
  });

  // Add constraint: expires_at must be after created_at
  pgm.addConstraint('print_sessions', 'session_timeout', {
    check: 'expires_at > created_at',
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE print_sessions IS 'User printing sessions with QR codes'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('print_sessions');
}
