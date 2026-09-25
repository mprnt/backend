import { Request, Response } from 'express';
import { sessionService } from '../services/sessionService';
import logger from '../utils/logger';

export class SessionController {
  /**
   * GET /api/v1/sessions
   * List all sessions with filtering and pagination
   */
  async listSessions(req: Request, res: Response): Promise<void> {
    const { status, kioskId, limit, offset } = req.query;

    logger.info('Listing sessions', {
      status,
      kioskId,
      limit,
      offset,
    });

    const filters = {
      status: status as string | undefined,
      kioskId: kioskId as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    };

    const result = await sessionService.listSessions(filters);

    res.status(200).json({
      status: 'success',
      data: {
        sessions: result.sessions.map((s: any) => ({
          sessionId: s.session_id,
          status: s.status,
          isExpired: s.is_expired,
          createdAt: s.created_at,
          expiresAt: s.expires_at,
          completedAt: s.completed_at,
          kiosk: {
            kioskId: s.kiosk.kiosk_id,
            location: s.kiosk.location,
            status: s.kiosk.status,
            printerStatus: s.kiosk.printer_status,
          },
        })),
        pagination: {
          total: result.total,
          limit: filters.limit || 20,
          offset: filters.offset || 0,
        },
        stats: {
          active: result.active,
          expired: result.expired,
        },
      },
    });
  }

  /**
   * POST /api/v1/sessions
   * Create a new print session
   */
  async createSession(req: Request, res: Response): Promise<void> {
    const { kioskId } = req.body;
    const clientIp = req.ip || req.socket.remoteAddress;
    const userAgent = req.headers['user-agent'];

    logger.info('Creating session request', {
      kioskId,
      clientIp,
      userAgent,
    });

    const { session, kiosk } = await sessionService.createSession(
      kioskId,
      clientIp,
      userAgent
    );

    res.status(201).json({
      status: 'success',
      data: {
        sessionId: session.session_id,
        expiresAt: session.expires_at,
        createdAt: session.created_at,
        status: session.status,
        kioskInfo: {
          kioskId: kiosk.kiosk_id,
          location: kiosk.location,
          capabilities: kiosk.capabilities,
          status: kiosk.status,
        },
      },
    });
  }

  /**
   * GET /api/v1/sessions/:sessionId
   * Get session details with associated document, print job, and payment
   */
  async getSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    logger.info('Getting session details', { sessionId });

    const { session, kiosk, document, printJob, payment } =
      await sessionService.getSessionDetails(sessionId);

    res.status(200).json({
      status: 'success',
      data: {
        session: {
          sessionId: session.session_id,
          status: session.status,
          createdAt: session.created_at,
          expiresAt: session.expires_at,
          completedAt: session.completed_at,
        },
        kiosk: {
          kioskId: kiosk.kiosk_id,
          location: kiosk.location,
          status: kiosk.status,
          capabilities: kiosk.capabilities,
        },
        document: document
          ? {
              id: document.id,
              filename: document.original_filename,
              fileType: document.file_type,
              pageCount: document.page_count,
              fileSizeBytes: document.file_size_bytes,
              uploadedAt: document.uploaded_at,
              processed: document.processed,
            }
          : null,
        printJob: printJob
          ? {
              id: printJob.id,
              status: printJob.status,
              settings: printJob.settings,
              totalAmount: printJob.total_amount,
              createdAt: printJob.created_at,
            }
          : null,
        payment: payment
          ? {
              transactionId: payment.transaction_id,
              status: payment.status,
              amount: payment.amount,
              method: payment.method,
              paidAt: payment.paid_at,
            }
          : null,
      },
    });
  }

  /**
   * DELETE /api/v1/sessions/:sessionId
   * Cancel/expire a session
   */
  async cancelSession(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    const session = await sessionService.cancelSession(sessionId);

    res.status(200).json({
      status: 'success',
      message: 'Session cancelled successfully',
      data: {
        sessionId: session.session_id,
        status: session.status,
        completedAt: session.completed_at,
      },
    });
  }
}

// Export singleton instance
export const sessionController = new SessionController();
