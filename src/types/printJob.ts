export type ColorMode = 'bw' | 'color';
export type PageRange = 'all' | 'custom';
export type PrintSides = 'single' | 'double';
export type PaperSize = 'a4' | 'letter';
export type Orientation = 'portrait' | 'landscape';
export type PrintJobStatus = 'pending' | 'queued' | 'printing' | 'completed' | 'failed' | 'cancelled';

export interface PrintSettings {
  colorMode: ColorMode;
  copies: number;
  pageRange: PageRange;
  customRange?: string;
  printSides: PrintSides;
  paperSize: PaperSize;
  orientation: Orientation;
}

export interface PricingBreakdown {
  colorMode: string;
  copies: number;
  pagesPerCopy: number;
  pricePerPage: number;
  subtotal: number;
}

export interface PricingResult {
  pricePerPage: number;
  logicalPages: number;
  physicalPages: number;
  totalPages: number;
  totalAmount: number;
  breakdown: PricingBreakdown;
}

export interface PrintJob {
  id: string;
  sessionId: string;
  documentId: string;
  kioskId: string;

  // Print settings
  colorMode: ColorMode;
  pageRange: PageRange;
  customRange?: string;
  copies: number;
  orientation: Orientation;
  paperSize: PaperSize;
  printSides: PrintSides;

  // Pricing
  basePricePerPage: number;
  totalPages: number;
  totalAmount: number;

  // Status
  status: PrintJobStatus;
  errorMessage?: string;
  retryCount: number;

  // Timestamps
  createdAt: Date;
  queuedAt?: Date;
  startedPrintingAt?: Date;
  completedAt?: Date;

  // Tracking
  printedPages: number;
  printDurationSeconds?: number;
}

export interface CreatePrintJobParams {
  sessionId: string;
  documentId: string;
  kioskId: string;
  settings: PrintSettings;
}

export interface UpdatePrintJobSettingsParams {
  jobId: string;
  settings: Partial<PrintSettings>;
}
