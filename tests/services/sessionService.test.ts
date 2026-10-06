import { SessionService } from '../../src/services/sessionService';
import { db } from '../../src/config/database';
import { Kiosk } from '../../src/types/database';
import { AppError } from '../../src/middleware/errorHandler';

// Mock database
jest.mock('../../src/config/database');
const mockDb = db as jest.Mocked<typeof db>;

describe('SessionService', () => {
  let sessionService: SessionService;

  beforeEach(() => {
    sessionService = new SessionService();
    jest.clearAllMocks();
  });

  describe('createSession', () => {
    const mockKiosk: Kiosk = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      kiosk_id: 'M001',
      location: 'Test Location',
      raspberry_pi_id: null,
      status: 'active',
      printer_status: null,
      ip_address: null,
      last_heartbeat: null,
      capabilities: { color: true, duplex: true, paper_sizes: ['a4'] },
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should create a session successfully', async () => {
      // Mock kiosk lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock session creation
      const mockSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: mockKiosk.id,
        status: 'draft',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        completed_at: null,
        client_ip: '127.0.0.1',
        user_agent: 'test-agent',
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [mockSession],
        command: 'INSERT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.createSession('M001', '127.0.0.1', 'test-agent');

      expect(result.session).toBeDefined();
      expect(result.kiosk).toEqual(mockKiosk);
      expect(result.session.status).toBe('draft');
      expect(result.session.session_id).toMatch(/^S\d+$/);
    });

    it('should throw error if kiosk not found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(
        sessionService.createSession('INVALID', '127.0.0.1', 'test-agent')
      ).rejects.toThrow(new AppError('Kiosk not found', 404));
    });

    it('should throw error if kiosk is not active', async () => {
      const inactiveKiosk = { ...mockKiosk, status: 'maintenance' as const };
      mockDb.query.mockResolvedValueOnce({
        rows: [inactiveKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      await expect(sessionService.createSession('M001', '127.0.0.1', 'test-agent')).rejects.toThrow(
        AppError
      );
    });

    it('should generate unique session IDs', async () => {
      mockDb.query.mockResolvedValue({
        rows: [mockKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const sessionId1 = (sessionService as any).generateSessionId();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const sessionId2 = (sessionService as any).generateSessionId();

      expect(sessionId1).not.toBe(sessionId2);
      expect(sessionId1).toMatch(/^S\d+$/);
      expect(sessionId2).toMatch(/^S\d+$/);
    });

    it('should calculate expiry 15 minutes from now', () => {
      const now = new Date();
      const expiry = (sessionService as any).calculateExpiry();
      const diffMinutes = (expiry.getTime() - now.getTime()) / (1000 * 60);

      expect(diffMinutes).toBeGreaterThanOrEqual(14.9);
      expect(diffMinutes).toBeLessThanOrEqual(15.1);
    });
  });

  describe('getSession', () => {
    it('should retrieve a session by session_id', async () => {
      const mockSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'draft',
        created_at: new Date(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        completed_at: null,
        client_ip: null,
        user_agent: null,
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [mockSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.getSession('S1726999999999');

      expect(result).toEqual(mockSession);
    });

    it('should return null if session not found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.getSession('INVALID');

      expect(result).toBeNull();
    });
  });

  describe('isSessionExpired', () => {
    it('should return true if session is expired', () => {
      const expiredSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'draft' as const,
        created_at: new Date(Date.now() - 20 * 60 * 1000),
        expires_at: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        completed_at: null,
        client_ip: null,
        user_agent: null,
      };

      const result = sessionService.isSessionExpired(expiredSession);

      expect(result).toBe(true);
    });

    it('should return false if session is not expired', () => {
      const validSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'draft' as const,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes from now
        completed_at: null,
        client_ip: null,
        user_agent: null,
      };

      const result = sessionService.isSessionExpired(validSession);

      expect(result).toBe(false);
    });
  });

  describe('getSessionDetails', () => {
    const mockSession = {
      id: '456e4567-e89b-12d3-a456-426614174001',
      session_id: 'S1726999999999',
      kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
      status: 'draft' as const,
      created_at: new Date(),
      expires_at: new Date(Date.now() + 15 * 60 * 1000),
      completed_at: null,
      client_ip: '127.0.0.1',
      user_agent: 'test-agent',
    };

    const mockKiosk: Kiosk = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      kiosk_id: 'M001',
      location: 'Test Location',
      raspberry_pi_id: null,
      status: 'active',
      printer_status: null,
      ip_address: null,
      last_heartbeat: null,
      capabilities: { color: true, duplex: true, paper_sizes: ['a4'] },
      created_at: new Date(),
      updated_at: new Date(),
    };

    it('should retrieve complete session details with all associations', async () => {
      const mockDocument = {
        id: 'doc-123',
        session_id: mockSession.id,
        original_filename: 'test.pdf',
        file_type: 'application/pdf',
        page_count: 5,
        file_size_bytes: 1024000,
        uploaded_at: new Date(),
        processed: true,
      };

      const mockPrintJob = {
        id: 'job-123',
        session_id: mockSession.id,
        status: 'queued',
        settings: { color: false, copies: 1 },
        total_amount: 10.0,
        created_at: new Date(),
      };

      const mockPayment = {
        id: 'pay-123',
        print_job_id: mockPrintJob.id,
        transaction_id: 'TXN123',
        status: 'success',
        amount: 10.0,
        method: 'upi',
        paid_at: new Date(),
      };

      // Mock session lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock kiosk lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock document lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockDocument],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock print job lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockPrintJob],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock payment lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockPayment],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.getSessionDetails('S1726999999999');

      expect(result.session).toEqual(mockSession);
      expect(result.kiosk).toEqual(mockKiosk);
      expect(result.document).toEqual(mockDocument);
      expect(result.printJob).toEqual(mockPrintJob);
      expect(result.payment).toEqual(mockPayment);
    });

    it('should return null for missing associations', async () => {
      // Mock session lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock kiosk lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock no document
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      // Mock no print job
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      // Mock no payment
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.getSessionDetails('S1726999999999');

      expect(result.session).toEqual(mockSession);
      expect(result.kiosk).toEqual(mockKiosk);
      expect(result.document).toBeNull();
      expect(result.printJob).toBeNull();
      expect(result.payment).toBeNull();
    });

    it('should throw 404 if session not found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(sessionService.getSessionDetails('INVALID')).rejects.toThrow(
        new AppError('Session not found', 404)
      );
    });

    it('should throw 410 if session is expired', async () => {
      const expiredSession = {
        ...mockSession,
        expires_at: new Date(Date.now() - 5 * 60 * 1000), // 5 minutes ago
        status: 'draft' as const,
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [expiredSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // No paid job
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(sessionService.getSessionDetails('S1726999999999')).rejects.toThrow(
        new AppError('Session has expired', 410)
      );
    });

    it('keeps an expired session readable once it has been paid', async () => {
      const expiredSession = {
        ...mockSession,
        expires_at: new Date(Date.now() - 5 * 60 * 1000),
        status: 'draft' as const,
      };
      const paidJob = { id: 'job-1', status: 'printing', payment_status: 'paid' };

      mockDb.query.mockImplementation(async (sql: string) => {
        const rows = sql.includes('FROM print_sessions')
          ? [expiredSession]
          : sql.includes("payment_status IN ('paid', 'refunded')")
            ? [{ '?column?': 1 }]
            : sql.includes('FROM kiosks')
              ? [mockKiosk]
              : sql.includes('FROM print_jobs')
                ? [paidJob]
                : [];
        return { rows, command: 'SELECT', rowCount: rows.length, oid: 0, fields: [] };
      });

      const result = await sessionService.getSessionDetails('S1726999999999');

      expect(result.printJob).toEqual(paidJob);
      expect(sessionService.isSessionExpired(result.session)).toBe(true);
      mockDb.query.mockReset();
    });

    it('should allow retrieval of expired but completed sessions', async () => {
      const completedSession = {
        ...mockSession,
        expires_at: new Date(Date.now() - 5 * 60 * 1000), // expired
        status: 'complete' as const,
        completed_at: new Date(),
      };

      // Mock session lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [completedSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock kiosk lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [mockKiosk],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock no document, print job, payment
      mockDb.query.mockResolvedValue({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.getSessionDetails('S1726999999999');

      expect(result.session.status).toBe('complete');
    });
  });

  describe('cancelSession', () => {
    it('should cancel a session successfully', async () => {
      const mockSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'draft' as const,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 15 * 60 * 1000),
        completed_at: null,
        client_ip: null,
        user_agent: null,
      };

      // Mock get session
      mockDb.query.mockResolvedValueOnce({
        rows: [mockSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock paid-job check: none
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      // Mock update session
      const cancelledSession = {
        ...mockSession,
        status: 'expired' as const,
        completed_at: new Date(),
      };
      mockDb.query.mockResolvedValueOnce({
        rows: [cancelledSession],
        command: 'UPDATE',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      const result = await sessionService.cancelSession('S1726999999999');

      expect(result.status).toBe('expired');
      expect(result.completed_at).toBeDefined();
    });

    it('refuses to cancel a session whose paid job is still printing', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [
            {
              id: '456e4567-e89b-12d3-a456-426614174001',
              session_id: 'S1726999999999',
              status: 'draft',
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        })
        .mockResolvedValueOnce({
          rows: [{ '?column?': 1 }],
          command: 'SELECT',
          rowCount: 1,
          oid: 0,
          fields: [],
        });

      const err = await sessionService.cancelSession('S1726999999999').catch((e: AppError) => e);

      expect((err as AppError).statusCode).toBe(409);
      expect((err as AppError).code).toBe('SESSION_PAID');
      expect(mockDb.query).toHaveBeenCalledTimes(2); // no UPDATE
    });

    it('should throw error if session not found', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      await expect(sessionService.cancelSession('INVALID')).rejects.toThrow(
        new AppError('Session not found', 404)
      );
    });

    it('should throw error if session is already completed', async () => {
      const completedSession = {
        id: '456e4567-e89b-12d3-a456-426614174001',
        session_id: 'S1726999999999',
        kiosk_id: '123e4567-e89b-12d3-a456-426614174000',
        status: 'complete' as const,
        created_at: new Date(),
        expires_at: new Date(),
        completed_at: new Date(),
        client_ip: null,
        user_agent: null,
      };

      mockDb.query.mockResolvedValueOnce({
        rows: [completedSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      await expect(sessionService.cancelSession('S1726999999999')).rejects.toThrow(
        new AppError('Cannot cancel a completed session', 400)
      );
    });
  });
});
