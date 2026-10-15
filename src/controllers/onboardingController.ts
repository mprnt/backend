import { Request, Response } from 'express';
import { AppError } from '../middleware/errorHandler';
import { auditService } from '../services/auditService';
import { onboardingService, RequestMeta } from '../services/onboardingService';

function requestMeta(req: Request): RequestMeta {
  return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

/** The file name as a download should carry it: letters, digits, dot, dash and underscore only. */
function safeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'document';
}

class OnboardingController {
  async createDraft(req: Request, res: Response): Promise<void> {
    const draft = await onboardingService.createDraft(req.admin!.id);
    await auditService.fromRequest(req, 'onboarding.draft_created', {
      resourceType: 'onboarding_draft',
      resourceId: draft.id,
    });
    res.status(201).json({ status: 'success', data: draft });
  }

  async getDraft(req: Request, res: Response): Promise<void> {
    const draft = await onboardingService.getDraft(req.params.draftId);
    res.json({ status: 'success', data: draft });
  }

  async patchDraft(req: Request, res: Response): Promise<void> {
    const body = req.body as { version: number; patch: Record<string, unknown> };
    const draft = await onboardingService.patchDraft(req.params.draftId, body.version, body.patch);
    res.json({ status: 'success', data: draft });
  }

  async addDocument(req: Request, res: Response): Promise<void> {
    if (!req.file) throw new AppError('Choose a file to upload', 400, 'NO_FILE');
    const doc = await onboardingService.addDocument(req.params.draftId, {
      kind:
        typeof (req.body as { kind?: unknown }).kind === 'string'
          ? (req.body as { kind: string }).kind
          : '',
      original: req.file.originalname,
      claimedType: req.file.mimetype,
      bytes: req.file.buffer,
      actorId: req.admin!.id,
    });
    res.status(201).json({ status: 'success', data: doc });
  }

  async removeDocument(req: Request, res: Response): Promise<void> {
    await onboardingService.removeDocument(req.params.draftId, req.params.docId);
    res.json({ status: 'success', data: null });
  }

  async complete(req: Request, res: Response): Promise<void> {
    const result = await onboardingService.complete(
      req.params.draftId,
      req.admin!.id,
      requestMeta(req)
    );
    // The temporary password is in this response only. It is never logged,
    // stored in the draft, or sent again: the operator hands it to the owner once.
    res.status(201).json({ status: 'success', data: result });
  }

  async listPartnerDocuments(req: Request, res: Response): Promise<void> {
    const documents = await onboardingService.listPartnerDocuments(req.params.id);
    res.json({ status: 'success', data: { documents } });
  }

  async downloadPartnerDocument(req: Request, res: Response): Promise<void> {
    const { id, docId } = req.params;
    const file = await onboardingService.readPartnerDocument(id, docId);

    await auditService.fromRequest(req, 'partner_document.viewed', {
      resourceType: 'partner_document',
      resourceId: docId,
      organizationId: id,
    });

    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(file.filename)}"`);
    res.setHeader('Content-Length', String(file.bytes.length));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(file.bytes);
  }
}

export const onboardingController = new OnboardingController();
