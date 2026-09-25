import { Router } from 'express';
import { documentController } from '../controllers/documentController';
import { uploadSingle } from '../middleware/upload';
import { asyncHandler } from '../utils/asyncHandler';

const router = Router();

/**
 * @swagger
 * /sessions/{sessionId}/documents:
 *   post:
 *     summary: Upload a document for printing
 *     description: Upload a PDF document to a print session. Document will be processed for page count and thumbnails.
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *         description: Session ID
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: PDF file to upload (max 10MB)
 *     responses:
 *       201:
 *         description: Document uploaded successfully
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
 *                   example: Document uploaded successfully
 *                 data:
 *                   $ref: '#/components/schemas/Document'
 *       400:
 *         description: Invalid file or session
 *       413:
 *         description: File too large
 */
router.post(
  '/:sessionId/documents',
  uploadSingle,
  asyncHandler(documentController.uploadDocument.bind(documentController))
);

/**
 * @swagger
 * /sessions/{sessionId}/documents:
 *   get:
 *     summary: Get session document
 *     description: Retrieve the document uploaded for a session
 *     tags: [Documents]
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Document retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                 data:
 *                   $ref: '#/components/schemas/Document'
 *       404:
 *         description: Document not found
 */
router.get(
  '/:sessionId/documents',
  asyncHandler(documentController.getSessionDocument.bind(documentController))
);

export default router;
