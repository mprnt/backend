import { processSessionExpiry } from '../../src/jobs/sessionExpiryJob';
import { db } from '../../src/config/database';
import { Job } from 'bull';

// Mock database
jest.mock('../../src/config/database');
const mockDb = db as jest.Mocked<typeof db>;

describe('Session Expiry Job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('processSessionExpiry', () => {
    it('should expire sessions and delete documents', async () => {
      const mockExpiredSessions = [
        {
          id: 'session-1',
          session_id: 'S1726999999999',
          expires_at: new Date(Date.now() - 5 * 60 * 1000),
          status: 'draft',
        },
        {
          id: 'session-2',
          session_id: 'S1726999999998',
          expires_at: new Date(Date.now() - 10 * 60 * 1000),
          status: 'draft',
        },
      ];

      const mockDocuments = [
        { id: 'doc-1', s3_key: 'uploads/doc1.pdf' },
        { id: 'doc-2', s3_key: 'uploads/doc2.pdf' },
      ];

      // Mock finding expired sessions
      mockDb.query.mockResolvedValueOnce({
        rows: mockExpiredSessions,
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      });

      // Mock transaction
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: mockDocuments }) // Find documents
          .mockResolvedValueOnce({ rows: [] }) // Delete documents
          .mockResolvedValueOnce({ rows: [] }), // Update session
      };

      mockDb.transaction.mockImplementation(async (callback) => {
        return await callback(mockClient as any);
      });

      const mockJob = {} as Job;
      const result = await processSessionExpiry(mockJob);

      expect(result.expiredCount).toBe(2);
      expect(result.documentsDeleted).toBe(2);
    });

    it('should return zero counts when no expired sessions found', async () => {
      // Mock no expired sessions
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const mockJob = {} as Job;
      const result = await processSessionExpiry(mockJob);

      expect(result.expiredCount).toBe(0);
      expect(result.documentsDeleted).toBe(0);
    });

    it('should handle sessions without documents', async () => {
      const mockExpiredSession = {
        id: 'session-1',
        session_id: 'S1726999999999',
        expires_at: new Date(Date.now() - 5 * 60 * 1000),
        status: 'draft',
      };

      // Mock finding expired session
      mockDb.query.mockResolvedValueOnce({
        rows: [mockExpiredSession],
        command: 'SELECT',
        rowCount: 1,
        oid: 0,
        fields: [],
      });

      // Mock transaction with no documents
      const mockClient = {
        query: jest.fn()
          .mockResolvedValueOnce({ rows: [] }) // No documents found
          .mockResolvedValueOnce({ rows: [] }), // Update session
      };

      mockDb.transaction.mockImplementation(async (callback) => {
        return await callback(mockClient as any);
      });

      const mockJob = {} as Job;
      const result = await processSessionExpiry(mockJob);

      expect(result.expiredCount).toBe(1);
      expect(result.documentsDeleted).toBe(0);
    });

    it('should continue processing even if one session fails', async () => {
      const mockExpiredSessions = [
        {
          id: 'session-1',
          session_id: 'S1726999999999',
          expires_at: new Date(Date.now() - 5 * 60 * 1000),
          status: 'draft',
        },
        {
          id: 'session-2',
          session_id: 'S1726999999998',
          expires_at: new Date(Date.now() - 10 * 60 * 1000),
          status: 'draft',
        },
      ];

      // Mock finding expired sessions
      mockDb.query.mockResolvedValueOnce({
        rows: mockExpiredSessions,
        command: 'SELECT',
        rowCount: 2,
        oid: 0,
        fields: [],
      });

      // Mock transaction - first fails, second succeeds
      mockDb.transaction
        .mockRejectedValueOnce(new Error('Database error'))
        .mockImplementation(async (callback) => {
          const mockClient = {
            query: jest.fn()
              .mockResolvedValueOnce({ rows: [] }) // No documents
              .mockResolvedValueOnce({ rows: [] }), // Update session
          };
          return await callback(mockClient as any);
        });

      const mockJob = {} as Job;
      const result = await processSessionExpiry(mockJob);

      // Should still report both sessions (attempted to process)
      expect(result.expiredCount).toBe(2);
    });

    it('should not expire already expired or completed sessions', async () => {
      // Mock query returns empty (no sessions to expire)
      mockDb.query.mockResolvedValueOnce({
        rows: [],
        command: 'SELECT',
        rowCount: 0,
        oid: 0,
        fields: [],
      });

      const mockJob = {} as Job;
      const result = await processSessionExpiry(mockJob);

      expect(result.expiredCount).toBe(0);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('should throw error if database query fails', async () => {
      // Mock database error
      mockDb.query.mockRejectedValueOnce(new Error('Database connection failed'));

      const mockJob = {} as Job;

      await expect(processSessionExpiry(mockJob)).rejects.toThrow('Database connection failed');
    });
  });
});
