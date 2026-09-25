/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Print Jobs Indexes
  pgm.createIndex('print_jobs', 'session_id', { name: 'idx_print_jobs_session' });
  pgm.createIndex('print_jobs', ['kiosk_id', 'status'], { name: 'idx_print_jobs_kiosk_status' });
  pgm.createIndex('print_jobs', 'created_at', {
    name: 'idx_print_jobs_created',
    method: 'btree',
    order: 'DESC',
  });
  pgm.createIndex('print_jobs', 'status', {
    name: 'idx_print_jobs_status',
    where: "status IN ('pending', 'queued', 'printing')",
  });

  // Payments Indexes
  pgm.createIndex('payments', 'transaction_id', { name: 'idx_payments_transaction' });
  pgm.createIndex('payments', ['status', 'initiated_at'], { name: 'idx_payments_status' });

  // Print Sessions Indexes
  pgm.createIndex('print_sessions', ['kiosk_id', 'created_at'], {
    name: 'idx_sessions_kiosk',
    method: 'btree',
    order: 'DESC',
  });
  pgm.createIndex('print_sessions', 'status', { name: 'idx_sessions_status' });

  // Analytics Events Indexes
  pgm.createIndex('analytics_events', ['kiosk_id', 'occurred_at'], {
    name: 'idx_analytics_kiosk_time',
  });
  pgm.createIndex('analytics_events', ['event_type', 'occurred_at'], {
    name: 'idx_analytics_event_type',
  });
  pgm.createIndex('analytics_events', 'occurred_at', {
    name: 'idx_analytics_time_series',
    method: 'btree',
    order: 'DESC',
  });

  // Daily Stats Indexes
  pgm.createIndex('daily_stats', 'date', {
    name: 'idx_daily_stats_date',
    method: 'btree',
    order: 'DESC',
  });

  pgm.sql(`COMMENT ON INDEX idx_print_jobs_session IS 'Fast lookup of jobs by session'`);
  pgm.sql(`COMMENT ON INDEX idx_print_jobs_status IS 'Optimize active job queries'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop all indexes
  pgm.dropIndex('print_jobs', 'session_id', { name: 'idx_print_jobs_session' });
  pgm.dropIndex('print_jobs', ['kiosk_id', 'status'], { name: 'idx_print_jobs_kiosk_status' });
  pgm.dropIndex('print_jobs', 'created_at', { name: 'idx_print_jobs_created' });
  pgm.dropIndex('print_jobs', 'status', { name: 'idx_print_jobs_status' });

  pgm.dropIndex('payments', 'transaction_id', { name: 'idx_payments_transaction' });
  pgm.dropIndex('payments', ['status', 'created_at'], { name: 'idx_payments_status' });

  pgm.dropIndex('print_sessions', ['kiosk_id', 'created_at'], { name: 'idx_sessions_kiosk' });
  pgm.dropIndex('print_sessions', 'status', { name: 'idx_sessions_status' });

  pgm.dropIndex('analytics_events', ['kiosk_id', 'occurred_at'], {
    name: 'idx_analytics_kiosk_time',
  });
  pgm.dropIndex('analytics_events', ['event_type', 'occurred_at'], {
    name: 'idx_analytics_event_type',
  });
  pgm.dropIndex('analytics_events', 'occurred_at', { name: 'idx_analytics_time_series' });

  pgm.dropIndex('daily_stats', 'date', { name: 'idx_daily_stats_date' });
}
