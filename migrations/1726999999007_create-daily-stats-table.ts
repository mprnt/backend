/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create daily_stats table
  pgm.createTable('daily_stats', {
    id: {
      type: 'serial',
      primaryKey: true,
    },
    date: {
      type: 'date',
      notNull: true,
    },
    kiosk_id: {
      type: 'uuid',
      references: 'kiosks(id)',
    },
    total_sessions: {
      type: 'integer',
      default: 0,
    },
    completed_sessions: {
      type: 'integer',
      default: 0,
    },
    total_prints: {
      type: 'integer',
      default: 0,
    },
    total_pages: {
      type: 'integer',
      default: 0,
    },
    total_revenue: {
      type: 'decimal(10,2)',
      default: 0,
    },
    bw_pages: {
      type: 'integer',
      default: 0,
    },
    color_pages: {
      type: 'integer',
      default: 0,
    },
    avg_session_duration_seconds: {
      type: 'integer',
    },
    failed_prints: {
      type: 'integer',
      default: 0,
    },
    last_updated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  // Add unique constraint
  pgm.addConstraint('daily_stats', 'unique_date_kiosk', {
    unique: ['date', 'kiosk_id'],
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE daily_stats IS 'Pre-aggregated daily statistics for admin dashboard'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('daily_stats');
}
