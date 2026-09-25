/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create analytics_events table
  pgm.createTable('analytics_events', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    event_type: {
      type: 'varchar(50)',
      notNull: true,
    },
    kiosk_id: {
      type: 'uuid',
      references: 'kiosks(id)',
    },
    session_id: {
      type: 'uuid',
      references: 'print_sessions(id)',
    },
    event_data: {
      type: 'jsonb',
    },
    occurred_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE analytics_events IS 'Real-time analytics events for admin dashboard'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('analytics_events');
}
