/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create print_jobs table
  pgm.createTable('print_jobs', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    session_id: {
      type: 'uuid',
      references: 'print_sessions(id)',
    },
    document_id: {
      type: 'uuid',
      references: 'documents(id)',
    },
    kiosk_id: {
      type: 'uuid',
      references: 'kiosks(id)',
    },
    color_mode: {
      type: 'varchar(10)',
      notNull: true,
    },
    page_range: {
      type: 'varchar(50)',
      default: "'all'",
    },
    custom_range: {
      type: 'text',
    },
    copies: {
      type: 'integer',
      default: 1,
      notNull: true,
    },
    orientation: {
      type: 'varchar(10)',
      default: "'portrait'",
    },
    paper_size: {
      type: 'varchar(10)',
      default: "'a4'",
    },
    print_sides: {
      type: 'varchar(10)',
      default: "'single'",
    },
    base_price_per_page: {
      type: 'decimal(10,2)',
      notNull: true,
    },
    total_pages: {
      type: 'integer',
      notNull: true,
    },
    total_amount: {
      type: 'decimal(10,2)',
      notNull: true,
    },
    status: {
      type: 'varchar(20)',
      default: "'pending'",
    },
    error_message: {
      type: 'text',
    },
    retry_count: {
      type: 'integer',
      default: 0,
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    queued_at: {
      type: 'timestamp',
    },
    started_printing_at: {
      type: 'timestamp',
    },
    completed_at: {
      type: 'timestamp',
    },
    printed_pages: {
      type: 'integer',
      default: 0,
    },
    print_duration_seconds: {
      type: 'integer',
    },
  });

  // Add constraints
  pgm.addConstraint('print_jobs', 'copies_range', {
    check: 'copies > 0 AND copies <= 100',
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE print_jobs IS 'Print jobs queue and history'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('print_jobs');
}
