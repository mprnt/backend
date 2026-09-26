import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import logger from '../utils/logger';

export interface PrinterCapabilities {
  supportsColor: boolean;
  supportsDoubleSided: boolean;
  maxCopies: number;
  supportedPaperSizes: string[];
}

export interface Printer {
  id: string;
  printerId: string;
  kioskId: string;
  name: string;
  ipAddress?: string;
  status: 'online' | 'offline' | 'maintenance' | 'error';
  capabilities: PrinterCapabilities;
  lastHeartbeat: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrinterRegistration {
  printerId: string;
  kioskId: string;
  name: string;
  ipAddress?: string;
  capabilities: PrinterCapabilities;
}

export class PrinterService {
  constructor(private database: Database = db) {}

  /**
   * Register or update a printer (Raspberry Pi)
   */
  async registerPrinter(params: PrinterRegistration): Promise<Printer> {
    const result = await this.database.query(
      `INSERT INTO printers (
        printer_id, kiosk_id, name, ip_address,
        supports_color, supports_double_sided, max_copies, supported_paper_sizes,
        status, last_heartbeat, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'online', NOW(), NOW(), NOW())
      ON CONFLICT (printer_id) DO UPDATE SET
        name = EXCLUDED.name,
        ip_address = EXCLUDED.ip_address,
        supports_color = EXCLUDED.supports_color,
        supports_double_sided = EXCLUDED.supports_double_sided,
        max_copies = EXCLUDED.max_copies,
        supported_paper_sizes = EXCLUDED.supported_paper_sizes,
        status = 'online',
        last_heartbeat = NOW(),
        updated_at = NOW()
      RETURNING *`,
      [
        params.printerId,
        params.kioskId,
        params.name,
        params.ipAddress,
        params.capabilities.supportsColor,
        params.capabilities.supportsDoubleSided,
        params.capabilities.maxCopies,
        JSON.stringify(params.capabilities.supportedPaperSizes),
      ]
    );

    return this.rowToPrinter(result.rows[0]);
  }

  /**
   * Get printer by ID
   */
  async getPrinter(printerId: string): Promise<Printer> {
    const result = await this.database.query(
      'SELECT * FROM printers WHERE printer_id = $1',
      [printerId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Printer not found', 404);
    }

    return this.rowToPrinter(result.rows[0]);
  }

  /**
   * Get all printers for a kiosk
   */
  async getPrintersForKiosk(kioskId: string): Promise<Printer[]> {
    const result = await this.database.query(
      'SELECT * FROM printers WHERE kiosk_id = $1 ORDER BY created_at',
      [kioskId]
    );

    return result.rows.map(row => this.rowToPrinter(row));
  }

  /**
   * Find available printers matching job requirements
   */
  async findAvailablePrinters(
    kioskId: string,
    colorMode: 'bw' | 'color',
    doubleSided: boolean
  ): Promise<Printer[]> {
    const result = await this.database.query(
      `SELECT * FROM printers 
       WHERE kiosk_id = $1 
       AND status = 'online'
       AND (supports_color = true OR $2 = false)
       AND (supports_double_sided = true OR $3 = false)
       ORDER BY last_heartbeat DESC`,
      [kioskId, colorMode === 'color', doubleSided]
    );

    return result.rows.map(row => this.rowToPrinter(row));
  }

  /**
   * Update printer status
   */
  async updatePrinterStatus(
    printerId: string,
    status: 'online' | 'offline' | 'maintenance' | 'error'
  ): Promise<Printer> {
    const result = await this.database.query(
      `UPDATE printers 
       SET status = $1, last_heartbeat = NOW(), updated_at = NOW()
       WHERE printer_id = $2
       RETURNING *`,
      [status, printerId]
    );

    if (result.rows.length === 0) {
      throw new AppError('Printer not found', 404);
    }

    return this.rowToPrinter(result.rows[0]);
  }

  /**
   * Update printer heartbeat
   */
  async updateHeartbeat(printerId: string): Promise<void> {
    await this.database.query(
      `UPDATE printers SET last_heartbeat = NOW(), status = 'online' WHERE printer_id = $1`,
      [printerId]
    );
  }

  /**
   * Get offline printers (no heartbeat for 5 minutes)
   */
  async getOfflinePrinters(): Promise<Printer[]> {
    const result = await this.database.query(
      `SELECT * FROM printers 
       WHERE status = 'online' 
       AND last_heartbeat < NOW() - INTERVAL '5 minutes'`
    );

    return result.rows.map(row => this.rowToPrinter(row));
  }

  /**
   * Mark stale printers as offline
   */
  async markStaleAsOffline(): Promise<number> {
    const result = await this.database.query(
      `UPDATE printers 
       SET status = 'offline', updated_at = NOW()
       WHERE status = 'online' 
       AND last_heartbeat < NOW() - INTERVAL '5 minutes'`
    );

    logger.info('Marked stale printers as offline', { count: result.rowCount });
    return result.rowCount || 0;
  }

  private rowToPrinter(row: any): Printer {
    return {
      id: row.id,
      printerId: row.printer_id,
      kioskId: row.kiosk_id,
      name: row.name,
      ipAddress: row.ip_address,
      status: row.status,
      capabilities: {
        supportsColor: row.supports_color,
        supportsDoubleSided: row.supports_double_sided,
        maxCopies: row.max_copies,
        supportedPaperSizes: row.supported_paper_sizes || [],
      },
      lastHeartbeat: new Date(row.last_heartbeat),
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export const printerService = new PrinterService();
