/* eslint-disable @typescript-eslint/naming-convention */
import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // Insert sample kiosk for development
  pgm.sql(`
    INSERT INTO kiosks (kiosk_id, location, status, capabilities)
    VALUES (
      'M001',
      'Development Test Location',
      'active',
      '{"color": true, "duplex": true, "paper_sizes": ["a4", "letter"]}'::jsonb
    );
  `);

  pgm.sql(`COMMENT ON TABLE kiosks IS 'Sample kiosk created for development'`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DELETE FROM kiosks WHERE kiosk_id = 'M001'`);
}
