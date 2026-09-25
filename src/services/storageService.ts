import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import env from '../config/environment';
import logger from '../utils/logger';
import crypto from 'crypto';

/**
 * S3/MinIO Storage Service
 * Handles file uploads, downloads, and deletions
 */
class StorageService {
  private s3Client: S3Client;
  private bucketName: string;

  constructor() {
    // Initialize S3 client (works with both AWS S3 and MinIO)
    this.s3Client = new S3Client({
      region: env.storage.aws_region,
      endpoint: env.storage.s3_endpoint, // For MinIO
      forcePathStyle: !!env.storage.s3_endpoint, // Required for MinIO
      credentials: {
        accessKeyId: env.storage.aws_access_key_id,
        secretAccessKey: env.storage.aws_secret_access_key,
      },
    });

    this.bucketName = env.storage.s3_bucket_name;

    logger.info('Storage service initialized', {
      type: env.storage.s3_endpoint ? 'MinIO' : 'AWS S3',
      bucket: this.bucketName,
      region: env.storage.aws_region,
    });
  }

  /**
   * Generate unique file key
   */
  generateFileKey(sessionId: string, originalFilename: string): string {
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const extension = originalFilename.split('.').pop();
    return `sessions/${sessionId}/${timestamp}-${randomString}.${extension}`;
  }

  /**
   * Upload file to S3/MinIO
   */
  async uploadFile(
    key: string,
    fileBuffer: Buffer,
    contentType: string
  ): Promise<string> {
    try {
      const command = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: fileBuffer,
        ContentType: contentType,
      });

      await this.s3Client.send(command);

      logger.info('File uploaded to storage', {
        key,
        contentType,
        size: fileBuffer.length,
      });

      return key;
    } catch (error) {
      logger.error('Failed to upload file to storage', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get file from S3/MinIO
   */
  async getFile(key: string): Promise<Buffer> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      const stream = response.Body as any;

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      return Buffer.concat(chunks);
    } catch (error) {
      logger.error('Failed to get file from storage', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Download file from S3/MinIO (alias for getFile)
   */
  async downloadFile(key: string): Promise<Buffer> {
    return this.getFile(key);
  }

  /**
   * Delete file from S3/MinIO
   */
  async deleteFile(key: string): Promise<void> {
    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      await this.s3Client.send(command);

      logger.info('File deleted from storage', { key });
    } catch (error) {
      logger.error('Failed to delete file from storage', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Generate pre-signed URL for file download (expires in 1 hour)
   */
  async getPresignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });

      const url = await getSignedUrl(this.s3Client, command, { expiresIn });

      logger.info('Generated pre-signed URL', {
        key,
        expiresIn,
      });

      return url;
    } catch (error) {
      logger.error('Failed to generate pre-signed URL', {
        key,
        error: error instanceof Error ? error.message : error,
      });
      throw error;
    }
  }

  /**
   * Get public URL for file (if bucket is public)
   */
  getPublicUrl(key: string): string {
    if (env.storage?.s3_endpoint) {
      // MinIO or custom endpoint
      return `${env.storage.s3_endpoint}/${this.bucketName}/${key}`;
    } else {
      // AWS S3
      const region = env.storage?.aws_region || 'us-east-1';
      return `https://${this.bucketName}.s3.${region}.amazonaws.com/${key}`;
    }
  }
}

// Export singleton instance
export const storageService = new StorageService();
