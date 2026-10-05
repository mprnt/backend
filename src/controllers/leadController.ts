import { Request, Response } from 'express';
import { leadService } from '../services/leadService';
import logger from '../utils/logger';

class LeadController {
  /**
   * POST /api/v1/public/leads
   * Contact form submission from MPrint Web.
   */
  async createLead(req: Request, res: Response): Promise<void> {
    const body = req.body as {
      name: string;
      email: string;
      message: string;
      phone?: string;
      company?: string;
      source?: string;
      website?: string;
    };

    // Honeypot filled: answer like a success so bots learn nothing.
    if (body.website) {
      logger.warn('Lead honeypot triggered', { ip: req.ip });
      res.status(201).json({
        status: 'success',
        message: 'Thanks, we will be in touch',
        data: { leadId: null, createdAt: new Date().toISOString() },
      });
      return;
    }

    const lead = await leadService.create({
      name: body.name,
      email: body.email,
      message: body.message,
      phone: body.phone || undefined,
      company: body.company || undefined,
      source: body.source,
      clientIp: req.ip,
      userAgent: req.headers['user-agent'],
    });

    logger.info('Lead received', { leadId: lead.id, source: body.source });

    res.status(201).json({
      status: 'success',
      message: 'Thanks, we will be in touch',
      data: { leadId: lead.id, createdAt: lead.createdAt },
    });
  }

  /**
   * GET /api/v1/admin/leads
   */
  async listLeads(req: Request, res: Response): Promise<void> {
    const { limit, offset } = req.query as unknown as { limit: number; offset: number };
    const { leads, total } = await leadService.list(limit, offset);

    res.json({
      status: 'success',
      data: { leads, pagination: { total, limit, offset } },
    });
  }
}

export const leadController = new LeadController();
