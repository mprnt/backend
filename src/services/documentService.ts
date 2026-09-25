import { db } from '../config/database';
import { storageService } from './storageService';
import { sessionService } from './sessionService';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import crypto from 'crypto';
import { addDocumentProcessingJob } from '../queues/documentQueue';
import { cacheService, CacheKeys } from './cacheService';

interface UploadDocumentParams {
  sessionId: string;
  file: Express.Multer.File;
}

interface Document {
  id: string;
  session_id: string;
  original_filename: string;
  file_type: string;
  file_size_bytes: number;
  s3_key: string;
  page_count: number | null;
  processed: boolean;
  uploaded_at: Date;
}

export class DocumentService {
  /**
   * Extract page count from PDF (placeholder for now)
   * TODO: Implement with pdf-parse library
   */
  private async extractPageCount(mimeType: string): Promise<number | null> {
    if (mimeType === 'application/pdf') {
      // TODO: Use pdf-parse to extract page count
      // For now, return null (will implement in next step)
      logger.info('PDF page extraction not yet implemented');
      return null;
    }

    // For images, page count is always 1
    if (mimeType.startsWith('image/')) {
      return 1;
    }

    return null;
  }

  /**
   * Upload document for a session
   */
  async uploadDocument(params: UploadDocumentParams): Promise<Document> {
    const { sessionId, file } = params;

    // Validate session exists and is not expired
    const session = await sessionService.getSession(sessionId);

    if (!session) {
      throw new AppError('Session not found', 404);
    }

    if (sessionService.isSessionExpired(session)) {
      throw new AppError('Session has expired', 410);
    }

    // Check if document already exists for this session
    const existingDoc = await db.query(
      'SELECT id FROM documents WHERE session_id = $1',
      [session.id]
    );

    if (existingDoc.rows.length > 0) {
      throw new AppError('Document already uploaded for this session', 400);
    }

    logger.info('Uploading document', {
      sessionId,
      filename: file.originalname,
      size: file.size,
      mimeType: file.mimetype,
    });

    try {
      // Generate S3 key
      const s3Key = storageService.generateFileKey(sessionId, file.originalname);

      // Upload to S3/MinIO
      await storageService.uploadFile(s3Key, file.buffer, file.mimetype);

      // Extract page count
      const pageCount = await this.extractPageCount(file.mimetype);

      // Store document metadata in database
      const documentId = crypto.randomUUID();

      const result = await db.query<Document>(
        `INSERT INTO documents
         (id, session_id, original_filename, file_type, file_size_bytes, s3_key, page_count, processed, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          documentId,
          session.id,
          file.originalname,
          file.mimetype,
          file.size,
          s3Key,
          pageCount,
          false, // Not processed yet
        ]
      );

      const document = result.rows[0];

      logger.info('Document uploaded successfully', {
        documentId: document.id,
        sessionId,
        s3Key,
        pageCount,
      });

      // Queue document for background processing
      await addDocumentProcessingJob({
        documentId: document.id,
        sessionId,
        s3Key,
        fileType: file.mimetype,
        originalFilename: file.originalname,
      });

      logger.info('Document queued for processing', {
        documentId: document.id,
      });

      return document;
    } catch (error) {
      logger.error('Failed to upload document', {
        sessionId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get document by ID
   */
  async getDocument(documentId: string): Promise<Document | null> {
    const result = await db.query<Document>(
      'SELECT * FROM documents WHERE id = $1',
      [documentId]
    );

    return result.rows[0] || null;
  }

  /**
   * Get document by session ID
   */
  async getDocumentBySessionId(sessionId: string): Promise<Document | null> {
    // First get session internal ID
    const session = await sessionService.getSession(sessionId);
    if (!session) {
      return null;
    }

    const result = await db.query<Document>(
      'SELECT * FROM documents WHERE session_id = $1',
      [session.id]
    );

    return result.rows[0] || null;
  }

  /**
   * Delete document (from both database and storage)
   */
  async deleteDocument(documentId: string): Promise<void> {
    const document = await this.getDocument(documentId);

    if (!document) {
      throw new AppError('Document not found', 404);
    }

    try {
      // Delete from S3/MinIO
      await storageService.deleteFile(document.s3_key);

      // Delete thumbnail if it exists
      if (document.file_type.startsWith('image/')) {
        try {
          await storageService.deleteFile(`${document.s3_key}-thumb.jpg`);
        } catch (error) {
          // Thumbnail might not exist, ignore error
          logger.debug('Thumbnail deletion skipped (not found)', {
            documentId,
          });
        }
      }

      // Delete from database
      await db.query('DELETE FROM documents WHERE id = $1', [documentId]);

      // Invalidate cache
      await cacheService.del([
        CacheKeys.preview(documentId),
        CacheKeys.document(documentId),
      ]);

      logger.info('Document deleted', {
        documentId,
        s3Key: document.s3_key,
      });
    } catch (error) {
      logger.error('Failed to delete document', {
        documentId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get pre-signed download URL for document
   */
  async getDownloadUrl(documentId: string, expiresIn: number = 3600): Promise<string> {
    const document = await this.getDocument(documentId);

    if (!document) {
      throw new AppError('Document not found', 404);
    }

    return await storageService.getPresignedUrl(document.s3_key, expiresIn);
  }

  /**
   * Get document preview with thumbnails (with Redis caching)
   */
  async getDocumentPreview(documentId: string): Promise<{
    documentId: string;
    filename: string;
    fileType: string;
    pageCount: number | null;
    processed: boolean;
    thumbnails: string[];
    documentUrl: string;
  }> {
    // Check cache first
    const cacheKey = CacheKeys.preview(documentId);
    const cached = await cacheService.get<{
      documentId: string;
      filename: string;
      fileType: string;
      pageCount: number | null;
      processed: boolean;
      thumbnails: string[];
      documentUrl: string;
    }>(cacheKey);

    if (cached) {
      logger.debug('Preview cache hit', { documentId });
      return cached;
    }

    // Cache miss - generate preview
    logger.debug('Preview cache miss', { documentId });

    const document = await this.getDocument(documentId);

    if (!document) {
      throw new AppError('Document not found', 404);
    }

    // Collect all S3 keys for URL generation
    const urlsToGenerate: { key: string; type: 'thumbnail' | 'document' }[] = [];

    // For images, check if thumbnail exists
    if (document.file_type.startsWith('image/')) {
      const thumbnailKey = `${document.s3_key}-thumb.jpg`;
      urlsToGenerate.push({ key: thumbnailKey, type: 'thumbnail' });
    }

    // For PDFs, check for thumbnails (first 3 pages)
    if (document.file_type === 'application/pdf' && document.processed) {
      // Check for PDF thumbnails (page 1-3)
      for (let page = 1; page <= 3; page++) {
        const thumbnailKey = `${document.s3_key}-thumb-page${page}.jpg`;
        urlsToGenerate.push({ key: thumbnailKey, type: 'thumbnail' });
      }
    }

    // Always add document URL
    urlsToGenerate.push({ key: document.s3_key, type: 'document' });

    // Generate all URLs in parallel for better performance
    const urlResults = await Promise.allSettled(
      urlsToGenerate.map(({ key }) => storageService.getPresignedUrl(key, 3600))
    );

    // Separate thumbnails from document URL
    const thumbnails: string[] = [];
    let documentUrl = '';

    urlResults.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (urlsToGenerate[index].type === 'thumbnail') {
          thumbnails.push(result.value);
        } else {
          documentUrl = result.value;
        }
      } else {
        // Log failed URL generation (likely thumbnail doesn't exist)
        if (urlsToGenerate[index].type === 'thumbnail') {
          logger.debug('Thumbnail not found', {
            documentId,
            key: urlsToGenerate[index].key,
          });
        }
      }
    });

    const preview = {
      documentId: document.id,
      filename: document.original_filename,
      fileType: document.file_type,
      pageCount: document.page_count,
      processed: document.processed,
      thumbnails,
      documentUrl,
    };

    // Cache for 5 minutes (300 seconds)
    await cacheService.set(cacheKey, preview, 300);

    logger.info('Document preview generated', {
      documentId,
      thumbnailCount: thumbnails.length,
      processed: document.processed,
      cached: true,
    });

    return preview;
  }
}

// Export singleton instance
export const documentService = new DocumentService();
