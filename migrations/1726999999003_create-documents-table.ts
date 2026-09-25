/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Create documents table
  pgm.createTable('documents', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('uuid_generate_v4()'),
    },
    session_id: {
      type: 'uuid',
      notNull: true,
      references: 'print_sessions(id)',
      onDelete: 'CASCADE',
    },
    original_filename: {
      type: 'varchar(255)',
      notNull: true,
    },
    file_size: {
      type: 'bigint',
      notNull: true,
    },
    mime_type: {
      type: 'varchar(100)',
      notNull: true,
    },
    storage_path: {
      type: 'text',
      notNull: true,
    },
    page_count: {
      type: 'integer',
      notNull: true,
    },
    processed: {
      type: 'boolean',
      default: false,
    },
    processed_path: {
      type: 'text',
    },
    uploaded_at: {
      type: 'timestamp',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
    processed_at: {
      type: 'timestamp',
    },
  });

  // Add comment
  pgm.sql(`COMMENT ON TABLE documents IS 'Uploaded documents for printing'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('documents');
}
