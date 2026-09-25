import { Job } from 'bull';
import { db } from '../config/database';
import { storageService } from '../services/storageService';
import logger from '../utils/logger';
import sharp from 'sharp';
import { PDFParse } from 'pdf-parse';

interface DocumentJobData {
  documentId: string;
  sessionId: string;
  s3Key: string;
  fileType: string;
  originalFilename: string;
}

interface ProcessingResult {
  documentId: string;
  pageCount: number | null;
  thumbnailGenerated: boolean;
  processingTime: number;
}

/**
 * Document Processor Worker
 * Processes uploaded documents in the background
 */
export class DocumentProcessor {
  /**
   * Extract page count from PDF
   */
  private async extractPdfPageCount(buffer: Buffer): Promise<number> {
    const parser = new PDFParse({ data: buffer });

    try {
      const data = await parser.getInfo({ parsePageInfo: true });
      logger.info('PDF page extraction successful', {
        pages: data.total,
      });
      return data.total;
    } catch (error) {
      logger.error('Failed to extract PDF page count', {
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    } finally {
      await parser.destroy();
    }
  }

  /**
   * Generate thumbnail for document
   */
  private async generateThumbnail(
    buffer: Buffer,
    fileType: string,
    s3Key: string
  ): Promise<boolean> {
    try {
      void s3Key;
      // For images, generate thumbnail using sharp
      if (fileType.startsWith('image/')) {
        void buffer;
        const thumbnail = await sharp(buffer)
          .resize(200, 200, { fit: 'inside' })
          .jpeg({ quality: 80 })
          .toBuffer();

        const thumbnailKey = `${s3Key}-thumb.jpg`;
        await storageService.uploadFile(thumbnailKey, thumbnail, 'image/jpeg');

        logger.info('Image thumbnail generated successfully', {
          originalKey: s3Key,
          thumbnailKey,
        });
        return true;
      }

      // For PDFs, would need pdf-to-image conversion
      // This is more complex and can be added later
      logger.info('PDF thumbnail generation not yet implemented');
      return false;
    } catch (error) {
      logger.error('Failed to generate thumbnail', {
        error: error instanceof Error ? error.message : error,
      });
      return false;
    }
  }

  /**
   * Process document job
   */
  async process(job: Job<DocumentJobData>): Promise<ProcessingResult> {
    const startTime = Date.now();
    const { documentId, s3Key, fileType, originalFilename } = job.data;

    logger.info('Starting document processing', {
      jobId: job.id,
      documentId,
      fileType,
      originalFilename,
    });

    try {
      // Download document from S3
      const fileBuffer = await storageService.downloadFile(s3Key);

      let pageCount: number | null = null;
      let thumbnailGenerated = false;

      // Extract page count based on file type
      if (fileType === 'application/pdf') {
        pageCount = await this.extractPdfPageCount(fileBuffer);
      } else if (fileType.startsWith('image/')) {
        // Images are always 1 page
        pageCount = 1;
      } else {
        throw new Error(`Unsupported document type: ${fileType}`);
      }

      if (pageCount === null) {
        throw new Error('Unable to determine document page count');
      }

      // Generate thumbnail
      thumbnailGenerated = await this.generateThumbnail(fileBuffer, fileType, s3Key);

      // Update document in database
      await db.query(
        `UPDATE documents
         SET page_count = $1,
             processed = $2,
             processed_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [pageCount, true, documentId]
      );

      const processingTime = Date.now() - startTime;

      logger.info('Document processing completed successfully', {
        jobId: job.id,
        documentId,
        pageCount,
        thumbnailGenerated,
        processingTime,
      });

      return {
        documentId,
        pageCount,
        thumbnailGenerated,
        processingTime,
      };
    } catch (error) {
      logger.error('Document processing failed', {
        jobId: job.id,
        documentId,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }
}

// Export singleton instance
export const documentProcessor = new DocumentProcessor();
