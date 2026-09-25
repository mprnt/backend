import { Request, Response } from 'express';
import { documentService } from '../services/documentService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';

export class DocumentController {
  /**
   * POST /api/v1/sessions/:sessionId/documents
   * Upload document for a session
   */
  async uploadDocument(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;
    const file = req.file;

    if (!file) {
      throw new AppError('No file uploaded', 400);
    }

    logger.info('Document upload request', {
      sessionId,
      filename: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });

    const document = await documentService.uploadDocument({
      sessionId,
      file,
    });

    res.status(201).json({
      status: 'success',
      message: 'Document uploaded successfully',
      data: {
        documentId: document.id,
        filename: document.original_filename,
        fileType: document.file_type,
        fileSizeBytes: document.file_size_bytes,
        pageCount: document.page_count,
        processed: document.processed,
        uploadedAt: document.uploaded_at,
      },
    });
  }

  /**
   * GET /api/v1/sessions/:sessionId/documents
   * Get document for a session
   */
  async getSessionDocument(req: Request, res: Response): Promise<void> {
    const { sessionId } = req.params;

    const document = await documentService.getDocumentBySessionId(sessionId);

    if (!document) {
      res.status(404).json({
        status: 'error',
        message: 'No document found for this session',
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: {
        documentId: document.id,
        filename: document.original_filename,
        fileType: document.file_type,
        fileSizeBytes: document.file_size_bytes,
        pageCount: document.page_count,
        processed: document.processed,
        uploadedAt: document.uploaded_at,
      },
    });
  }

  /**
   * GET /api/v1/documents/:documentId
   * Get document details
   */
  async getDocument(req: Request, res: Response): Promise<void> {
    const { documentId } = req.params;

    const document = await documentService.getDocument(documentId);

    if (!document) {
      res.status(404).json({
        status: 'error',
        message: 'Document not found',
      });
      return;
    }

    res.status(200).json({
      status: 'success',
      data: {
        documentId: document.id,
        filename: document.original_filename,
        fileType: document.file_type,
        fileSizeBytes: document.file_size_bytes,
        pageCount: document.page_count,
        processed: document.processed,
        uploadedAt: document.uploaded_at,
      },
    });
  }

  /**
   * GET /api/v1/documents/:documentId/preview
   * Get document preview with thumbnails
   */
  async getPreview(req: Request, res: Response): Promise<void> {
    const { documentId } = req.params;

    logger.info('Document preview request', { documentId });

    const preview = await documentService.getDocumentPreview(documentId);

    res.status(200).json({
      status: 'success',
      data: preview,
    });
  }

  /**
   * GET /api/v1/documents/:documentId/download
   * Get pre-signed download URL
   */
  async getDownloadUrl(req: Request, res: Response): Promise<void> {
    const { documentId } = req.params;

    const url = await documentService.getDownloadUrl(documentId);

    res.status(200).json({
      status: 'success',
      data: {
        downloadUrl: url,
        expiresIn: 3600, // 1 hour
      },
    });
  }

  /**
   * DELETE /api/v1/documents/:documentId
   * Delete document
   */
  async deleteDocument(req: Request, res: Response): Promise<void> {
    const { documentId } = req.params;

    await documentService.deleteDocument(documentId);

    res.status(200).json({
      status: 'success',
      message: 'Document deleted successfully',
    });
  }
}

// Export singleton instance
export const documentController = new DocumentController();
