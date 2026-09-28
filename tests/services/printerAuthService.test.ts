import crypto from 'crypto';
import { PrinterAuthService } from '../../src/services/printerAuthService';
import { db } from '../../src/config/database';

jest.mock('../../src/config/database');
const mockDb = db as jest.Mocked<typeof db>;

const result = (rows: any[]) => ({
  rows,
  command: 'SELECT',
  rowCount: rows.length,
  oid: 0,
  fields: [],
});

const sha256 = (v: string) => crypto.createHash('sha256').update(v, 'utf8').digest('hex');

describe('PrinterAuthService', () => {
  let service: PrinterAuthService;

  beforeEach(() => {
    service = new PrinterAuthService();
    jest.clearAllMocks();
  });

  describe('verifyApiKey', () => {
    const printerRow = {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      printer_id: 'RPI_M001_01',
      kiosk_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'Kiosk M001 - Printer A',
      revoked_at: null,
    };

    it('accepts the correct key and returns the printer identity', async () => {
      const key = 'mprnt_pk_correct-key';
      mockDb.query.mockResolvedValueOnce(
        result([{ ...printerRow, api_key_hash: sha256(key) }]) as any
      );

      const printer = await service.verifyApiKey('RPI_M001_01', key);

      expect(printer).toEqual({
        id: printerRow.id,
        printerId: 'RPI_M001_01',
        kioskId: printerRow.kiosk_id,
        name: printerRow.name,
        revokedAt: null,
      });
    });

    it('rejects a wrong key', async () => {
      mockDb.query.mockResolvedValueOnce(
        result([{ ...printerRow, api_key_hash: sha256('mprnt_pk_real') }]) as any
      );

      await expect(service.verifyApiKey('RPI_M001_01', 'mprnt_pk_wrong')).resolves.toBeNull();
    });

    it('rejects an unknown printer without revealing that it is unknown', async () => {
      mockDb.query.mockResolvedValueOnce(result([]) as any);

      await expect(service.verifyApiKey('NOPE', 'mprnt_pk_anything')).resolves.toBeNull();
    });

    it('rejects a printer that has no key issued yet', async () => {
      mockDb.query.mockResolvedValueOnce(result([{ ...printerRow, api_key_hash: null }]) as any);

      await expect(service.verifyApiKey('RPI_M001_01', 'mprnt_pk_any')).resolves.toBeNull();
    });

    it('surfaces revocation so the middleware can deny with 403', async () => {
      const key = 'mprnt_pk_revoked';
      const revokedAt = new Date();
      mockDb.query.mockResolvedValueOnce(
        result([{ ...printerRow, api_key_hash: sha256(key), revoked_at: revokedAt }]) as any
      );

      const printer = await service.verifyApiKey('RPI_M001_01', key);

      expect(printer?.revokedAt).toBe(revokedAt);
    });
  });

  describe('issueApiKeyIfAbsent', () => {
    it('returns a prefixed, high-entropy key and stores only its digest', async () => {
      mockDb.query.mockResolvedValueOnce(
        result([{ printer_id: 'RPI_M001_01', api_key_issued_at: new Date() }]) as any
      );

      const issued = await service.issueApiKeyIfAbsent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

      expect(issued).not.toBeNull();
      expect(issued!.apiKey).toMatch(/^mprnt_pk_[A-Za-z0-9_-]{43}$/);
      expect(issued!.prefix).toBe(issued!.apiKey.slice(0, 16));

      // The plaintext key must never reach the database.
      const [sql, params] = mockDb.query.mock.calls[0];
      expect(sql).toContain('api_key_hash');
      expect(params).toContain(sha256(issued!.apiKey));
      expect(params).not.toContain(issued!.apiKey);
    });

    it('does not overwrite an existing key', async () => {
      // The UPDATE ... WHERE api_key_hash IS NULL matches nothing.
      mockDb.query.mockResolvedValueOnce(result([]) as any);

      await expect(
        service.issueApiKeyIfAbsent('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      ).resolves.toBeNull();
    });

    it('issues a different key every time', async () => {
      mockDb.query.mockResolvedValue(
        result([{ printer_id: 'RPI_M001_01', api_key_issued_at: new Date() }]) as any
      );

      const a = await service.issueApiKeyIfAbsent('id-1');
      const b = await service.issueApiKeyIfAbsent('id-2');

      expect(a!.apiKey).not.toEqual(b!.apiKey);
    });
  });

  describe('revoke', () => {
    it('reports whether a printer was actually revoked', async () => {
      mockDb.query.mockResolvedValueOnce({ ...result([]), rowCount: 1 } as any);
      await expect(service.revoke('RPI_M001_01')).resolves.toBe(true);

      mockDb.query.mockResolvedValueOnce({ ...result([]), rowCount: 0 } as any);
      await expect(service.revoke('RPI_M001_01')).resolves.toBe(false);
    });
  });
});
