/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create payments table
  pgm.createTable('payments', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    print_job_id: {
      type: 'uuid',
      references: 'print_jobs(id)',
    },
    session_id: {
      type: 'uuid',
      references: 'print_sessions(id)',
    },
    amount: {
      type: 'decimal(10,2)',
      notNull: true,
    },
    payment_method: {
      type: 'varchar(20)',
      notNull: true,
    },
    transaction_id: {
      type: 'varchar(100)',
      notNull: true,
      unique: true,
    },
    gateway_response: {
      type: 'jsonb',
    },
    payment_gateway: {
      type: 'varchar(50)',
    },
    status: {
      type: 'varchar(20)',
      default: "'pending'",
    },
    initiated_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    completed_at: {
      type: 'timestamp',
    },
    reconciled: {
      type: 'boolean',
      default: false,
    },
    reconciled_at: {
      type: 'timestamp',
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE payments IS 'Payment transactions and reconciliation'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('payments');
}
