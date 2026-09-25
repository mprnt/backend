/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Enable UUID extension
  pgm.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');

  // Create kiosks table
  pgm.createTable('kiosks', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    kiosk_id: {
      type: 'varchar(10)',
      notNull: true,
      unique: true,
    },
    location: {
      type: 'varchar(255)',
      notNull: true,
    },
    raspberry_pi_id: {
      type: 'varchar(50)',
      unique: true,
    },
    status: {
      type: 'varchar(20)',
      default: "'active'",
    },
    printer_status: {
      type: 'jsonb',
    },
    ip_address: {
      type: 'inet',
    },
    last_heartbeat: {
      type: 'timestamp',
    },
    capabilities: {
      type: 'jsonb',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE kiosks IS 'Kiosk devices and their configuration'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('kiosks');
  pgm.sql('DROP EXTENSION IF EXISTS "uuid-ossp"');
}
