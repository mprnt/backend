/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create audit_logs table
  pgm.createTable('audit_logs', {
    id: {
      type: 'bigserial',
      primaryKey: true,
    },
    admin_user_id: {
      type: 'uuid',
      references: 'admin_users(id)',
    },
    action: {
      type: 'varchar(100)',
      notNull: true,
    },
    resource_type: {
      type: 'varchar(50)',
    },
    resource_id: {
      type: 'uuid',
    },
    ip_address: {
      type: 'inet',
    },
    user_agent: {
      type: 'text',
    },
    details: {
      type: 'jsonb',
    },
    created_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE audit_logs IS 'Audit trail for admin actions'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('audit_logs');
}
