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

export interface UpdateJobStatusParams {
  jobId: string;
  status: JobQueueStatus;
  errorMessage?: string;
  printedPages?: number;
}

export interface PollQueueParams {
  printerId: string;
  capabilities: PrinterCapabilities;
}

export interface JobAssignment {
  jobId: string;
  documentUrl: string;
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
}
