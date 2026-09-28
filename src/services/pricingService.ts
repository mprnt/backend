import { AppError } from '../utils/errors';
import { PrintSettings, PricingResult } from '../types/printJob';
import logger from '../utils/logger';

// Pricing constants (in INR)
const PRICING = {
  BW_PER_PAGE: 2.0,
  COLOR_PER_PAGE: 5.0,
} as const;

export class PricingService {
  /**
   * Calculate price for a print job based on settings and document page count
   */
  async calculatePrice(settings: PrintSettings, documentPageCount: number): Promise<PricingResult> {
    try {
      // Validate settings
      this.validateSettings(settings, documentPageCount);

      // Parse page range to get list of pages to print
      const pagesToPrint = this.parsePageRange(
        settings.pageRange === 'all' ? 'all' : settings.customRange!,
        documentPageCount
      );

      // Calculate logical pages (pages selected from document)
      const logicalPages = pagesToPrint.length;

      // Calculate physical pages (accounting for double-sided printing)
      const physicalPages =
        settings.printSides === 'double' ? Math.ceil(logicalPages / 2) : logicalPages;

      // Get price per page based on color mode
      const pricePerPage =
        settings.colorMode === 'color' ? PRICING.COLOR_PER_PAGE : PRICING.BW_PER_PAGE;

      // Calculate total pages to charge for (physical pages * copies)
      const totalPages = physicalPages * settings.copies;

      // Calculate total amount
      const totalAmount = totalPages * pricePerPage;

      // Create pricing breakdown
      const breakdown = {
        colorMode: settings.colorMode,
        copies: settings.copies,
        pagesPerCopy: physicalPages,
        pricePerPage,
        subtotal: totalAmount,
      };

      const result: PricingResult = {
        pricePerPage,
        logicalPages,
        physicalPages,
        totalPages,
        totalAmount: parseFloat(totalAmount.toFixed(2)),
        breakdown,
      };

      logger.info('Pricing calculated', {
        settings,
        documentPageCount,
        result,
      });

      return result;
    } catch (error) {
      logger.error('Error calculating price', { error, settings });
      throw error;
    }
  }

  /**
   * Parse page range string into array of page numbers
   * Supports formats: "all", "1-5", "1,3,5", "1-3,7-9"
   */
  parsePageRange(range: string, maxPages: number): number[] {
    if (range === 'all') {
      return Array.from({ length: maxPages }, (_, i) => i + 1);
    }

    const pages = new Set<number>();
    const parts = range.split(',').map((s) => s.trim());

    for (const part of parts) {
      if (part.includes('-')) {
        // Range format: "1-5"
        const [startStr, endStr] = part.split('-').map((s) => s.trim());
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);

        if (isNaN(start) || isNaN(end)) {
          throw new AppError(`Invalid page range format: "${part}". Expected format: "1-5"`, 400);
        }

        if (start < 1) {
          throw new AppError(`Invalid page number: ${start}. Pages start at 1`, 400);
        }

        if (start > end) {
          throw new AppError(
            `Invalid page range: ${start}-${end}. Start must be less than or equal to end`,
            400
          );
        }

        if (end > maxPages) {
          throw new AppError(`Page ${end} exceeds document page count (${maxPages})`, 400);
        }

        for (let i = start; i <= end; i++) {
          pages.add(i);
        }
      } else {
        // Single page: "5"
        const page = parseInt(part, 10);

        if (isNaN(page)) {
          throw new AppError(`Invalid page number: "${part}". Expected a number`, 400);
        }

        if (page < 1) {
          throw new AppError(`Invalid page number: ${page}. Pages start at 1`, 400);
        }

        if (page > maxPages) {
          throw new AppError(`Page ${page} exceeds document page count (${maxPages})`, 400);
        }

        pages.add(page);
      }
    }

    if (pages.size === 0) {
      throw new AppError('No pages selected for printing', 400);
    }

    // Return sorted array of unique pages
    return Array.from(pages).sort((a, b) => a - b);
  }

  /**
   * Validate print settings
   */
  validateSettings(settings: PrintSettings, documentPageCount: number): void {
    // Validate copies
    if (settings.copies < 1 || settings.copies > 100) {
      throw new AppError('Copies must be between 1 and 100', 400);
    }

    // Validate custom range if provided
    if (settings.pageRange === 'custom' && !settings.customRange) {
      throw new AppError('Custom range is required when page range is "custom"', 400);
    }

    // Validate page range format
    if (settings.pageRange === 'custom' && settings.customRange) {
      // This will throw an error if the range is invalid
      this.parsePageRange(settings.customRange, documentPageCount);
    }
  }

  /**
   * Recalculate pricing when settings are updated
   */
  async recalculatePrice(
    currentSettings: PrintSettings,
    updates: Partial<PrintSettings>,
    documentPageCount: number
  ): Promise<PricingResult> {
    const newSettings: PrintSettings = {
      ...currentSettings,
      ...updates,
    };

    return this.calculatePrice(newSettings, documentPageCount);
  }

  /**
   * Get pricing information for display
   */
  getPricingInfo() {
    return {
      blackAndWhite: {
        pricePerPage: PRICING.BW_PER_PAGE,
        currency: 'INR',
        description: 'Black & White printing',
      },
      color: {
        pricePerPage: PRICING.COLOR_PER_PAGE,
        currency: 'INR',
        description: 'Color printing',
      },
      notes: [
        'Double-sided printing: Physical pages = Math.ceil(logical pages / 2)',
        'Total cost = (physical pages × copies) × price per page',
        'Maximum 100 copies per job',
      ],
    };
  }
}

export const pricingService = new PricingService();
