import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import { PrinterCapabilities } from '../types/queue';
import { queueService } from './queueService';
import { printerAuthService, IssuedApiKey } from './printerAuthService';
import logger from '../utils/logger';

export type KioskStatus = 'active' | 'inactive' | 'maintenance';

/**
 * Kiosks and printers, managed from the dashboard.
 *
 * Before this, a kiosk could only be created by the development-only setup
 * endpoint — blocked in production — so onboarding a second shop meant raw
 * SQL. Printers could only be enrolled with curl and a provisioning token.
 */
export class FleetService {
  constructor(private database: Database = db) {}

  async createKiosk(params: {
    kioskCode: string;
    name: string;
    location: string;
    organizationId: string;
    capabilities?: { color?: boolean; duplex?: boolean; paperSizes?: string[] };
  }): Promise<{ id: string; kioskId: string }> {
    const org = await this.database.query(
      `SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL`,
      [params.organizationId]
    );
    if (org.rows.length === 0) throw new AppError('Organization not found', 404);

    const code = params.kioskCode.toUpperCase();

    const clash = await this.database.query(`SELECT 1 FROM kiosks WHERE kiosk_id = $1`, [code]);
    if (clash.rows.length > 0) {
      throw new AppError(`Kiosk code ${code} is already in use`, 409);
    }

    const result = await this.database.query(
      `INSERT INTO kiosks (kiosk_id, name, location, organization_id, status, capabilities,
                           created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW())
       RETURNING id, kiosk_id`,
      [
        code,
        params.name,
        params.location,
        params.organizationId,
        JSON.stringify({
          color: params.capabilities?.color ?? false,
          duplex: params.capabilities?.duplex ?? false,
          paper_sizes: params.capabilities?.paperSizes ?? ['a4'],
        }),
      ]
    );

    logger.info('Kiosk created', { kioskId: code, organizationId: params.organizationId });
    return { id: result.rows[0].id, kioskId: result.rows[0].kiosk_id };
  }

  /**
   * Rename, relocate, or take a kiosk out of service. Customers scanning an
   * inactive or maintenance kiosk are told so by session creation, which
   * already refuses anything but 'active'.
   *
   * @param organizationId when set, the kiosk must belong to it (shop staff).
   */
  async updateKiosk(
    kioskUuid: string,
    organizationId: string | null,
    params: { name?: string; location?: string; status?: KioskStatus }
  ): Promise<{
    id: string;
    kioskId: string;
    name: string;
    location: string;
    status: string;
    organizationId: string | null;
  }> {
    const sets: string[] = [];
    const args: unknown[] = [kioskUuid];
    const assign = (column: string, value: unknown) => {
      if (value !== undefined) {
        args.push(value);
        sets.push(`${column} = $${args.length}`);
      }
    };

    assign('name', params.name);
    assign('location', params.location);
    assign('status', params.status);

    if (sets.length === 0) throw new AppError('Nothing to update', 400);
    sets.push('updated_at = NOW()');

    let scope = '';
    if (organizationId) {
      args.push(organizationId);
      scope = `AND organization_id = $${args.length}`;
    }

    const result = await this.database.query(
      `UPDATE kiosks SET ${sets.join(', ')}
        WHERE id = $1 ${scope}
        RETURNING id, kiosk_id, name, location, status, organization_id`,
      args
    );

    // Same 404 for "no such kiosk" and "not your kiosk", so the endpoint cannot
    // be used to probe other shops' kiosk ids.
    if (result.rows.length === 0) throw new AppError('Kiosk not found', 404);

    const r = result.rows[0];
    return {
      id: r.id,
      kioskId: r.kiosk_id,
      name: r.name,
      location: r.location,
      status: r.status,
      organizationId: r.organization_id,
    };
  }

  /**
   * Enroll a printer and issue its key. The key is returned exactly once.
   *
   * Refuses an existing printer id *before* touching it. The previous path
   * upserted first and only then noticed the printer already had a key, so a
   * repeat enrollment overwrote the printer's capabilities and marked it online
   * even though the request was rejected.
   */
  async enrollPrinter(params: {
    printerId: string;
    kioskUuid: string;
    name: string;
    capabilities: PrinterCapabilities;
    ipAddress?: string;
    /**
     * Whether the Pi itself is making this call. Registration stamps the printer
     * online with a fresh heartbeat, which is true when the Pi enrolls itself
     * but false when an admin enrolls it from the dashboard: no Pi has
     * connected yet, and showing it online would say it can print when it
     * cannot.
     */
    enrolledByDevice: boolean;
  }): Promise<IssuedApiKey & { kioskId: string; organizationId: string | null }> {
    const existing = await this.database.query(`SELECT 1 FROM printers WHERE printer_id = $1`, [
      params.printerId,
    ]);
    if (existing.rows.length > 0) {
      throw new AppError(
        'A printer with this id is already enrolled. Rotate its key instead of enrolling again.',
        409
      );
    }

    const kiosk = await this.database.query(
      `SELECT id, organization_id FROM kiosks WHERE id = $1`,
      [params.kioskUuid]
    );
    if (kiosk.rows.length === 0) throw new AppError('Kiosk not found', 404);

    const printer = await queueService.registerPrinter({
      printerId: params.printerId,
      kioskId: params.kioskUuid,
      name: params.name,
      capabilities: params.capabilities,
      ipAddress: params.ipAddress,
    });

    if (!params.enrolledByDevice) {
      await this.database.query(
        `UPDATE printers SET status = 'offline', last_heartbeat = NULL WHERE id = $1`,
        [printer.id]
      );
    }

    const issued = await printerAuthService.issueApiKeyIfAbsent(printer.id);
    if (!issued) {
      // Only reachable under a concurrent enrollment of the same id.
      throw new AppError('This printer was enrolled concurrently. Rotate its key instead.', 409);
    }

    return {
      ...issued,
      kioskId: params.kioskUuid,
      organizationId: kiosk.rows[0].organization_id,
    };
  }

  /**
   * Resolve a printer's organization, optionally enforcing that it belongs to
   * the given one. Used before rotate / revoke so a shop cannot act on another
   * shop's printer.
   */
  async printerOrganization(printerId: string, requiredOrg: string | null): Promise<string | null> {
    const result = await this.database.query(
      `SELECT k.organization_id
         FROM printers p JOIN kiosks k ON k.id = p.kiosk_id
        WHERE p.printer_id = $1`,
      [printerId]
    );
    if (result.rows.length === 0) throw new AppError('Printer not found', 404);

    const org = result.rows[0].organization_id as string | null;
    if (requiredOrg && org !== requiredOrg) throw new AppError('Printer not found', 404);
    return org;
  }
}

export const fleetService = new FleetService();
