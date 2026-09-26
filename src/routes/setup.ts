import { Router, Request, Response } from 'express';
import { db } from '../config/database';
import { asyncHandler } from '../utils/asyncHandler';
import logger from '../utils/logger';

const router = Router();

/**
 * @swagger
 * /setup/kiosks:
 *   post:
 *     summary: Setup default kiosks (Development only)
 *     description: Create kiosks table and insert default kiosk data
 *     tags: [Setup]
 *     responses:
 *       201:
 *         description: Kiosks setup successfully
 */
router.post(
  '/kiosks',
  asyncHandler(async (_req: Request, res: Response) => {
    logger.info('Setting up kiosks table');

    // Create kiosks table
    await db.query(`
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

    // Upgrade kiosks created by the initial schema, which did not have a name column.
    await db.query(`
      ALTER TABLE kiosks ADD COLUMN IF NOT EXISTS name VARCHAR(255);
      UPDATE kiosks SET name = kiosk_id WHERE name IS NULL;
      ALTER TABLE kiosks ALTER COLUMN name SET NOT NULL;
    `);

    logger.info('Kiosks table created');

    // Insert default kiosks
    await db.query(`
      INSERT INTO kiosks (kiosk_id, name, location, status, capabilities) VALUES
          ('KIOSK001', 'Main Library Kiosk', 'Library - Ground Floor', 'active', '{"supportsColor": true, "supportsDoubleSided": true, "paperSizes": ["a4", "letter"]}'),
          ('M001', 'Engineering Block Kiosk', 'Engineering Building - 1st Floor', 'active', '{"supportsColor": false, "supportsDoubleSided": true, "paperSizes": ["a4"]}'),
          ('M002', 'Student Center Kiosk', 'Student Center - Lobby', 'active', '{"supportsColor": true, "supportsDoubleSided": false, "paperSizes": ["a4", "letter"]}')
      ON CONFLICT (kiosk_id) DO NOTHING;
    `);

    logger.info('Default kiosks inserted');

    // Get all kiosks
    const result = await db.query('SELECT * FROM kiosks ORDER BY kiosk_id');

    res.status(201).json({
      status: 'success',
      message: 'Kiosks setup completed',
      data: {
        count: result.rows.length,
        kiosks: result.rows,
      },
    });
  })
);

/**
 * @swagger
 * /setup/kiosks:
 *   get:
 *     summary: List all kiosks
 *     tags: [Setup]
 *     responses:
 *       200:
 *         description: List of kiosks
 */
router.get(
  '/kiosks',
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await db.query('SELECT * FROM kiosks ORDER BY kiosk_id');

    res.json({
      status: 'success',
      data: {
        count: result.rows.length,
        kiosks: result.rows,
      },
    });
  })
);

export default router;
