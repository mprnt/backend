import { Router } from 'express';
import { documentController } from '../controllers/documentController';
import { asyncHandler } from '../utils/asyncHandler';
import { validateDocumentId } from '../middleware/validation';
import { sessionTokenForDocument } from '../middleware/sessionAuth';

const router = Router();

/**
 * @swagger
 * /documents/{documentId}:
 *   get:
 *     summary: Get document details
 *     description: Retrieve detailed information about a document including page count and processing status
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Document ID
 *     responses:
 *       200:
 *         description: Document details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   $ref: '#/components/schemas/Document'
 *       404:
 *         description: Document not found
 */
router.get(
  '/:documentId',
  validateDocumentId,
  sessionTokenForDocument,
  asyncHandler(documentController.getDocument.bind(documentController))
);

/**
 * @swagger
 * /documents/{documentId}/preview:
 *   get:
 *     summary: Get document preview with thumbnails
 *     description: |
 *       Retrieve preview thumbnails for document pages. Thumbnails are generated during document processing.
 *
 *       **Response includes:**
 *       - Document metadata
 *       - Array of thumbnail URLs (one per page)
 *       - Page count
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Document ID
 *     responses:
 *       200:
 *         description: Document preview retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     documentId:
 *                       type: string
 *                       format: uuid
 *                     fileName:
 *                       type: string
 *                     pageCount:
 *                       type: integer
 *                     thumbnails:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           page:
 *                             type: integer
 *                           url:
 *                             type: string
 *                             format: uri
 *       404:
 *         description: Document not found
 *       400:
 *         description: Document not yet processed
 */
router.get(
  '/:documentId/preview',
  validateDocumentId,
  sessionTokenForDocument,
  asyncHandler(documentController.getPreview.bind(documentController))
);

/**
 * @swagger
 * /documents/{documentId}/download:
 *   get:
 *     summary: Get document download URL
 *     description: |
 *       Get a pre-signed URL to download the original document from S3/MinIO.
 *
 *       **Note:** The returned URL is time-limited and will expire after a certain period.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Document ID
 *     responses:
 *       200:
 *         description: Download URL generated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 data:
 *                   type: object
 *                   properties:
 *                     documentId:
 *                       type: string
 *                       format: uuid
 *                     fileName:
 *                       type: string
 *                     downloadUrl:
 *                       type: string
 *                       format: uri
 *                       description: Pre-signed S3 URL (time-limited)
 *                     expiresIn:
 *                       type: integer
 *                       example: 3600
 *                       description: URL expiration time in seconds
 *       404:
 *         description: Document not found
 */
router.get(
  '/:documentId/download',
  validateDocumentId,
  sessionTokenForDocument,
  asyncHandler(documentController.getDownloadUrl.bind(documentController))
);

/**
 * @swagger
 * /documents/{documentId}:
 *   delete:
 *     summary: Delete document
 *     description: |
 *       Delete a document and its associated files from S3/MinIO.
 *
 *       **Warning:** This action cannot be undone. The document and all its thumbnails will be permanently deleted.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: documentId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Document ID
 *     responses:
 *       200:
 *         description: Document deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: success
 *                 message:
 *                   type: string
 *                   example: Document deleted successfully
 *       404:
 *         description: Document not found
 *       400:
 *         description: Cannot delete document (e.g., has associated print jobs)
 */
router.delete(
  '/:documentId',
  validateDocumentId,
  sessionTokenForDocument,
  asyncHandler(documentController.deleteDocument.bind(documentController))
);

export default router;
