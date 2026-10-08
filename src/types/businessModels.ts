/**
 * The four commercial models a partner can be on.
 *
 * Ids and labels mirror MPrnt/main/src/lib/models.ts, the website's single
 * source of truth for /for-businesses. Keep the two in step: these ids are
 * stored in organizations.business_model and are what the admin dashboard
 * filters and counts by.
 */

export const BUSINESS_MODEL_IDS = [
  'integration',
  'revenue-share',
  'own-station',
  'full-purchase',
] as const;

export type BusinessModelId = (typeof BUSINESS_MODEL_IDS)[number];

export interface BusinessModelInfo {
  id: BusinessModelId;
  /** "Model 1", "Model 2 · Option A", … as the website labels them. */
  label: string;
  /** Short label for dense tables and chips: "Model 1", "Model 2A". */
  short: string;
  name: string;
  /** Whether the hardware is an MPrnt station or the partner's own printer. */
  family: 'Printer Integration' | 'MPRNT Station';
}

export const BUSINESS_MODELS: BusinessModelInfo[] = [
  {
    id: 'integration',
    label: 'Model 1',
    short: 'Model 1',
    name: 'Printer Integration',
    family: 'Printer Integration',
  },
  {
    id: 'revenue-share',
    label: 'Model 2 · Option A',
    short: 'Model 2A',
    name: 'Station · Revenue Share',
    family: 'MPRNT Station',
  },
  {
    id: 'own-station',
    label: 'Model 2 · Option B',
    short: 'Model 2B',
    name: 'Station · Purchase + Monthly Software',
    family: 'MPRNT Station',
  },
  {
    id: 'full-purchase',
    label: 'Model 3',
    short: 'Model 3',
    name: 'Station · Full Purchase & Support',
    family: 'MPRNT Station',
  },
];

export function isBusinessModelId(value: unknown): value is BusinessModelId {
  return typeof value === 'string' && BUSINESS_MODEL_IDS.includes(value as BusinessModelId);
}
