export type PrinterStatus = 'online' | 'offline' | 'busy' | 'error' | 'maintenance';
export type JobQueueStatus =
  'queued' | 'assigned' | 'printing' | 'completed' | 'failed' | 'cancelled';

export interface Printer {
  id: string;
  printerId: string; // Unique identifier for Raspberry Pi
  kioskId: string;
  name: string;
  status: PrinterStatus;
  ipAddress?: string;
  lastHeartbeat: Date;
  capabilities: PrinterCapabilities;
  createdAt: Date;
  updatedAt: Date;
}

export interface PrinterCapabilities {
  supportsColor: boolean;
  supportsDoubleSided: boolean;
  maxCopies: number;
  supportedPaperSizes: string[];
}

export interface PrinterHeartbeat {
  printerId: string;
  status: PrinterStatus;
  currentJobId?: string;
  errorMessage?: string;
  paperLevel?: number;
  inkLevel?: {
    black?: number;
    color?: number;
  };
}

export interface QueuedJob {
  id: string;
  jobId: string;
  printerId?: string;
  priority: number;
  status: JobQueueStatus;
  assignedAt?: Date;
  startedAt?: Date;
  completedAt?: Date;
  failedAt?: Date;
  errorMessage?: string;
  retryCount: number;
  maxRetries: number;
}

export interface AssignJobParams {
  jobId: string;
  printerId: string;
}

/** Error codes a printer may report. Agreed with the Raspberry Pi client. */
export type PrintErrorCode =
  | 'OUT_OF_PAPER'
  | 'PAPER_JAM'
  | 'OUT_OF_TONER'
  | 'PRINTER_OFFLINE'
  | 'DOWNLOAD_FAILED'
  | 'UNSUPPORTED_DOCUMENT'
  | 'CUPS_ERROR'
  | 'TIMEOUT'
  | 'LEASE_EXPIRED'
  | 'UNKNOWN';

/** Statuses a printer is allowed to report. A printer can never set 'queued'. */
export type ReportableJobStatus = 'printing' | 'completed' | 'failed' | 'cancelled';

export interface UpdateJobStatusParams {
  jobId: string;
  status: ReportableJobStatus;
  errorMessage?: string;
  errorCode?: PrintErrorCode;
  printedPages?: number;
}

export interface PollQueueParams {
  printerId: string;
  capabilities: PrinterCapabilities;
}

export interface JobAssignment {
  /** print_jobs.id (UUID v4) — the canonical job identifier end to end. */
  jobId: string;
  /** Short-lived pre-signed S3 URL. Download immediately; do not cache. */
  documentUrl: string;
  documentUrlExpiresAt: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  settings: {
    colorMode: string;
    copies: number;
    pageRange: string;
    customRange?: string;
    printSides: string;
    paperSize: string;
    orientation: string;
  };
  totalPages: number;
  assignedAt: Date;
  /** Finish and report before this, or the job is reclaimed and reassigned. */
  leaseExpiresAt: string;
  /** 1 on the first attempt; higher after a retry. */
  attempt: number;
}
