/**
 * Insert Test Kiosks Script
 * Run this to populate your database with test kiosk data for Postman testing
 *
 * Usage: npx ts-node scripts/insert-test-kiosks.ts
 */

import { db } from '../src/config/database';
import logger from '../src/utils/logger';

const testKiosks = [
  {
    kiosk_id: 'M001',
    location: 'Main Building - Floor 1',
    status: 'active',
    capabilities: {
      color: true,
      duplex: true,
      paper_sizes: ['a4', 'letter', 'legal']
    },
    printer_status: 'idle',
    ip_address: '192.168.1.100'
  },
  {
    kiosk_id: 'M002',
    location: 'Library - Floor 2',
    status: 'maintenance',
    capabilities: {
      color: false,
      duplex: true,
      paper_sizes: ['a4']
    },
    printer_status: 'offline',
    ip_address: '192.168.1.101'
  },
  {
    kiosk_id: 'M003',
    location: 'Cafeteria - Ground Floor',
    status: 'offline',
    capabilities: {
      color: true,
      duplex: false,
      paper_sizes: ['a4', 'letter']
    },
    printer_status: 'offline',
    ip_address: '192.168.1.102'
  },
  {
    kiosk_id: '101',
    location: 'Test Location - Numeric ID',
    status: 'active',
    capabilities: {
      color: true,
      duplex: true,
      paper_sizes: ['a4']
    },
    printer_status: 'idle',
    ip_address: '192.168.1.201'
  }
];

async function insertTestKiosks() {
  try {
    logger.info('Starting to insert test kiosks...');

    for (const kiosk of testKiosks) {
      try {
        // Use INSERT ... ON CONFLICT to avoid duplicate key errors
        const result = await db.query(
          `INSERT INTO kiosks (kiosk_id, location, status, capabilities, printer_status, ip_address)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (kiosk_id) DO UPDATE SET
             location = EXCLUDED.location,
             status = EXCLUDED.status,
             capabilities = EXCLUDED.capabilities,
             printer_status = EXCLUDED.printer_status,
             ip_address = EXCLUDED.ip_address,
             updated_at = CURRENT_TIMESTAMP
           RETURNING kiosk_id, status`,
          [
            kiosk.kiosk_id,
            kiosk.location,
            kiosk.status,
            JSON.stringify(kiosk.capabilities),
            kiosk.printer_status,
            kiosk.ip_address
          ]
        );

        logger.info(`✅ Inserted/Updated kiosk: ${result.rows[0].kiosk_id} (${result.rows[0].status})`);
      } catch (error) {
        logger.error(`❌ Failed to insert kiosk ${kiosk.kiosk_id}:`, error);
      }
    }

    // Verify kiosks were inserted
    const verifyResult = await db.query(
      'SELECT kiosk_id, location, status, capabilities FROM kiosks ORDER BY kiosk_id'
    );

    console.log('\n📋 Current Kiosks in Database:');
    console.table(verifyResult.rows);

    logger.info(`\n✨ Successfully set up ${verifyResult.rows.length} test kiosks!`);
    logger.info('\n🧪 You can now test with these kiosk IDs:');
    logger.info('  - "M001" (active, color printer) ✅');
    logger.info('  - "M002" (maintenance - should return 400) ⚠️');
    logger.info('  - "M003" (offline - should return 400) ⚠️');
    logger.info('  - "101" (active, numeric ID) ✅');
    logger.info('  - "INVALID" (doesn\'t exist - should return 404) ❌');

    await db.close();
    process.exit(0);
  } catch (error) {
    logger.error('Failed to insert test kiosks:', error);
    process.exit(1);
  }
}

// Run the script
insertTestKiosks();
