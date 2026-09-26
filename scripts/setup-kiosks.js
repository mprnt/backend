const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

async function createKiosksTable() {
  const client = await pool.connect();

  try {
    console.log('Creating kiosks table...');

    await client.query(`
      CREATE TABLE IF NOT EXISTS kiosks (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          kiosk_id VARCHAR(50) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          location VARCHAR(255) NOT NULL,
          status VARCHAR(20) DEFAULT 'active',
          capabilities JSONB DEFAULT '{}',
          printer_status VARCHAR(20) DEFAULT 'idle',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          last_maintenance TIMESTAMP,
          CONSTRAINT chk_kiosk_status CHECK (status IN ('active', 'inactive', 'maintenance', 'offline'))
      );
    `);

    console.log('✓ Kiosks table created');

    console.log('Inserting default kiosks...');

    await client.query(`
      INSERT INTO kiosks (kiosk_id, name, location, status, capabilities) VALUES
          ('KIOSK001', 'Main Library Kiosk', 'Library - Ground Floor', 'active', '{"supportsColor": true, "supportsDoubleSided": true, "paperSizes": ["a4", "letter"]}'),
          ('M001', 'Engineering Block Kiosk', 'Engineering Building - 1st Floor', 'active', '{"supportsColor": false, "supportsDoubleSided": true, "paperSizes": ["a4"]}'),
          ('M002', 'Student Center Kiosk', 'Student Center - Lobby', 'active', '{"supportsColor": true, "supportsDoubleSided": false, "paperSizes": ["a4", "letter"]}')
      ON CONFLICT (kiosk_id) DO NOTHING;
    `);

    console.log('✓ Default kiosks inserted');

    const result = await client.query('SELECT kiosk_id, name, location FROM kiosks ORDER BY kiosk_id');
    console.log('\nRegistered Kiosks:');
    result.rows.forEach(row => {
      console.log(`  - ${row.kiosk_id}: ${row.name} (${row.location})`);
    });

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

createKiosksTable();
