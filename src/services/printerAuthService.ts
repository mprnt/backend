import crypto from 'crypto';
import { Database, db } from '../config/database';
import logger from '../utils/logger';

export interface AuthenticatedPrinter {
  /** Internal UUID (printers.id) — use this for every foreign key. */
  id: string;
  /** External, human-assigned identifier (printers.printer_id), e.g. RPI_M001_01. */
  printerId: string;
  kioskId: string;
  name: string;
  revokedAt: Date | null;
}

export interface IssuedApiKey {
  printerId: string;
  /** Plaintext key. Returned exactly once, at enrollment or rotation. */
  apiKey: string;
  prefix: string;
  issuedAt: Date;
}

/**
 * Printer API keys are 32 bytes of CSPRNG entropy, rendered base64url and
 * prefixed for readability: `mprnt_pk_<43 chars>`.
 *
 * Only the SHA-256 digest is persisted. With 256 bits of entropy a plain hash
 * is sufficient — there is no dictionary to attack, and it keeps per-request
 * verification cheap enough to sit in front of a 5-second polling loop.
 */
export class PrinterAuthService {
  constructor(private database: Database = db) {}

  private static readonly KEY_PREFIX = 'mprnt_pk_';

  private generateKey(): { key: string; hash: string; prefix: string } {
    const key = PrinterAuthService.KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
    return {
      key,
      hash: this.hash(key),
      prefix: key.slice(0, 16),
    };
  }

  private hash(key: string): string {
    return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
  }

  /**
   * Verify a presented key against the stored digest.
   *
   * Returns null for both "no such printer" and "wrong key" so callers cannot
   * distinguish the two.
   */
  async verifyApiKey(printerId: string, apiKey: string): Promise<AuthenticatedPrinter | null> {
    const result = await this.database.query(
      `SELECT id, printer_id, kiosk_id, name, api_key_hash, revoked_at
         FROM printers
        WHERE printer_id = $1`,
      [printerId]
    );

    if (result.rows.length === 0 || !result.rows[0].api_key_hash) {
      return null;
    }

    const row = result.rows[0];
    const presented = Buffer.from(this.hash(apiKey), 'hex');
    const stored = Buffer.from(row.api_key_hash, 'hex');

    if (presented.length !== stored.length || !crypto.timingSafeEqual(presented, stored)) {
      return null;
    }

    return {
      id: row.id,
      printerId: row.printer_id,
      kioskId: row.kiosk_id,
      name: row.name,
      revokedAt: row.revoked_at,
    };
  }

  /**
   * Issue a key for a printer that does not have one yet.
   * Returns null if the printer already holds an active key — rotation is a
   * separate, deliberate operation.
   */
  async issueApiKeyIfAbsent(printerUuid: string): Promise<IssuedApiKey | null> {
    const { key, hash, prefix } = this.generateKey();

    const result = await this.database.query(
      `UPDATE printers
          SET api_key_hash = $1,
              api_key_prefix = $2,
              api_key_issued_at = NOW(),
              revoked_at = NULL,
              updated_at = NOW()
        WHERE id = $3
          AND api_key_hash IS NULL
      RETURNING printer_id, api_key_issued_at`,
      [hash, prefix, printerUuid]
    );

    if (result.rows.length === 0) {
      return null;
    }

    logger.info('Printer API key issued', {
      printerId: result.rows[0].printer_id,
      prefix,
    });

    return {
      printerId: result.rows[0].printer_id,
      apiKey: key,
      prefix,
      issuedAt: result.rows[0].api_key_issued_at,
    };
  }

  /**
   * Replace an existing key. The previous key stops working immediately.
   */
  async rotateApiKey(printerId: string): Promise<IssuedApiKey | null> {
    const { key, hash, prefix } = this.generateKey();

    const result = await this.database.query(
      `UPDATE printers
          SET api_key_hash = $1,
              api_key_prefix = $2,
              api_key_issued_at = NOW(),
              revoked_at = NULL,
              updated_at = NOW()
        WHERE printer_id = $3
      RETURNING printer_id, api_key_issued_at`,
      [hash, prefix, printerId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    logger.warn('Printer API key rotated', { printerId, prefix });

    return {
      printerId: result.rows[0].printer_id,
      apiKey: key,
      prefix,
      issuedAt: result.rows[0].api_key_issued_at,
    };
  }

  /**
   * Revoke a printer's credentials without deleting the printer or its history.
   */
  async revoke(printerId: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE printers
          SET revoked_at = NOW(), status = 'offline', updated_at = NOW()
        WHERE printer_id = $1 AND revoked_at IS NULL`,
      [printerId]
    );

    if (result.rowCount) {
      logger.warn('Printer credentials revoked', { printerId });
    }

    return (result.rowCount || 0) > 0;
  }

  /**
   * Record the source IP of an authenticated request, for auditing which
   * physical device is using a key.
   */
  async recordSeen(printerUuid: string, ip?: string): Promise<void> {
    if (!ip) return;
    await this.database.query(`UPDATE printers SET last_seen_ip = $1 WHERE id = $2`, [
      ip.slice(0, 45),
      printerUuid,
    ]);
  }
}

export const printerAuthService = new PrinterAuthService();
