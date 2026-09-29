import { Database, db } from '../config/database';
import { AppError } from '../utils/errors';
import { PrintSettings, PricingResult } from '../types/printJob';
import logger from '../utils/logger';

export interface ResolvedPrices {
  bwPerPage: number;
  colorPerPage: number;
  minCharge: number;
  /** Which price list row supplied these rates, for auditing a quote. */
  source: 'kiosk' | 'organization' | 'platform';
  priceListId: string;
}

/**
 * Last-resort rates, used only if the platform default row is missing. Kept so a
 * misconfigured database degrades to the historical prices rather than to free.
 */
const FALLBACK = { bwPerPage: 2.0, colorPerPage: 5.0, minCharge: 0 };

export class PricingService {
  constructor(private database: Database = db) {}

  /**
   * Resolve the rates in force for a kiosk right now.
   *
   * Most specific wins: a kiosk override beats the organization default, which
   * beats the platform default. Within a scope the most recent row whose
   * `effective_from` has passed applies, so a future-dated price change sits
   * dormant until its moment.
   */
  async resolvePrices(kioskId?: string): Promise<ResolvedPrices> {
    if (kioskId) {
      const result = await this.database.query(
        `SELECT pl.id, pl.bw_per_page, pl.color_per_page, pl.min_charge,
                CASE
                  WHEN pl.kiosk_id IS NOT NULL        THEN 'kiosk'
                  WHEN pl.organization_id IS NOT NULL THEN 'organization'
                  ELSE 'platform'
                END AS source
           FROM price_lists pl
           LEFT JOIN kiosks k ON k.id = $1
          WHERE pl.effective_from <= NOW()
            AND (
                 pl.kiosk_id = $1
              OR (pl.kiosk_id IS NULL AND pl.organization_id = k.organization_id)
              OR (pl.kiosk_id IS NULL AND pl.organization_id IS NULL)
            )
          ORDER BY (pl.kiosk_id IS NOT NULL) DESC,
                   (pl.organization_id IS NOT NULL) DESC,
                   pl.effective_from DESC
          LIMIT 1`,
        [kioskId]
      );

      if (result.rows.length > 0) {
        const r = result.rows[0];
        return {
          bwPerPage: Number(r.bw_per_page),
          colorPerPage: Number(r.color_per_page),
          minCharge: Number(r.min_charge),
          source: r.source,
          priceListId: r.id,
        };
      }
    }

    const platform = await this.database.query(
      `SELECT id, bw_per_page, color_per_page, min_charge
         FROM price_lists
        WHERE organization_id IS NULL AND kiosk_id IS NULL AND effective_from <= NOW()
        ORDER BY effective_from DESC
        LIMIT 1`
    );

    if (platform.rows.length === 0) {
      logger.error('No platform price list configured — falling back to built-in rates');
      return { ...FALLBACK, source: 'platform', priceListId: 'fallback' };
    }

    const r = platform.rows[0];
    return {
      bwPerPage: Number(r.bw_per_page),
      colorPerPage: Number(r.color_per_page),
      minCharge: Number(r.min_charge),
      source: 'platform',
      priceListId: r.id,
    };
  }

  /**
   * Calculate price for a print job based on settings and document page count.
   *
   * @param kioskId resolves kiosk- and organization-specific rates. Omitted, the
   *                platform default applies.
   */
  async calculatePrice(
    settings: PrintSettings,
    documentPageCount: number,
    kioskId?: string
  ): Promise<PricingResult> {
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

      // Rates come from the database so the dashboard can change them without
      // a deploy. The caller snapshots the result onto the job, so a later price
      // change never alters what this customer was quoted.
      const prices = await this.resolvePrices(kioskId);
      const pricePerPage = settings.colorMode === 'color' ? prices.colorPerPage : prices.bwPerPage;

      // Calculate total pages to charge for (physical pages * copies)
      const totalPages = physicalPages * settings.copies;

      // Calculate total amount
      const totalAmount = Math.max(totalPages * pricePerPage, prices.minCharge);

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
   * Rates for display, resolved for a specific kiosk when one is given. This is
   * what the QR frontend shows before the customer picks their settings.
   */
  async getPricingInfo(kioskId?: string) {
    const prices = await this.resolvePrices(kioskId);

    return {
      blackAndWhite: {
        pricePerPage: prices.bwPerPage,
        currency: 'INR',
        description: 'Black & White printing',
      },
      color: {
        pricePerPage: prices.colorPerPage,
        currency: 'INR',
        description: 'Color printing',
      },
      minCharge: prices.minCharge,
      source: prices.source,
      notes: [
        'Double-sided printing: Physical pages = Math.ceil(logical pages / 2)',
        'Total cost = (physical pages × copies) × price per page',
        'Maximum 100 copies per job',
      ],
    };
  }
}

export const pricingService = new PricingService();
