import Joi from 'joi';

/**
 * A printerId is an operator-assigned label, not a secret. Constrained to a
 * predictable shape so it is safe to log and to use in metrics labels.
 */
const printerIdSchema = Joi.string()
  .pattern(/^[A-Za-z0-9_-]{3,64}$/)
  .messages({
    'string.pattern.base':
      'Printer ID must be 3-64 characters of letters, digits, underscore or hyphen',
  });

const capabilitiesSchema = Joi.object({
  supportsColor: Joi.boolean().required(),
  supportsDoubleSided: Joi.boolean().required(),
  maxCopies: Joi.number().integer().min(1).max(100).required(),
  supportedPaperSizes: Joi.array().items(Joi.string().max(20)).min(1).max(20).required(),
});

/** One-time enrollment; guarded by the provisioning token. */
export const enrollPrinterSchema = Joi.object({
  printerId: printerIdSchema.required().messages({
    'any.required': 'Printer ID is required',
  }),
  kioskId: Joi.string().uuid().required().messages({
    'string.guid': 'Kiosk ID must be a UUID',
    'any.required': 'Kiosk ID is required',
  }),
  name: Joi.string().min(1).max(255).required().messages({
    'any.required': 'Printer name is required',
  }),
  capabilities: capabilitiesSchema.required(),
  ipAddress: Joi.string().ip().optional(),
});

/**
 * Re-registration by an authenticated printer. printerId and kioskId are taken
 * from the credentials, so they are rejected here rather than silently ignored.
 */
export const registerPrinterSchema = Joi.object({
  name: Joi.string().min(1).max(255).optional(),
  capabilities: capabilitiesSchema.required(),
  ipAddress: Joi.string().ip().optional(),
});

export const heartbeatSchema = Joi.object({
  status: Joi.string()
    .valid('online', 'offline', 'busy', 'error', 'maintenance')
    .required()
    .messages({
      'any.required': 'Status is required',
      'any.only': 'Invalid printer status',
    }),
  currentJobId: Joi.string().uuid().optional(),
  errorMessage: Joi.string().max(1000).optional(),
  paperLevel: Joi.number().integer().min(0).max(100).optional(),
  inkLevel: Joi.object({
    black: Joi.number().integer().min(0).max(100).optional(),
    color: Joi.number().integer().min(0).max(100).optional(),
  }).optional(),
});

export const pollQueueSchema = Joi.object({
  // Advisory only: the server re-reads the printer's real capabilities from the
  // database before matching a job. Kept so a capability change is visible in logs.
  capabilities: capabilitiesSchema.optional(),
});

export const jobIdParamSchema = Joi.object({
  jobId: Joi.string().uuid().required().messages({
    'string.guid': 'Job ID must be a UUID',
  }),
});

export const printerIdParamSchema = Joi.object({
  printerId: printerIdSchema.required(),
});

/**
 * A printer may only report these four states. 'queued' and 'assigned' are
 * server-owned and rejected here.
 */
export const updateJobStatusSchema = Joi.object({
  status: Joi.string().valid('printing', 'completed', 'failed', 'cancelled').required().messages({
    'any.required': 'Status is required',
    'any.only': 'A printer may only report: printing, completed, failed, cancelled',
  }),
  // null means unknown. The backend never guesses a page count.
  printedPages: Joi.number().integer().min(0).max(10000).optional().allow(null),
  errorMessage: Joi.string().max(1000).optional().allow(null, ''),
  errorCode: Joi.string()
    .valid(
      'OUT_OF_PAPER',
      'PAPER_JAM',
      'OUT_OF_TONER',
      'PRINTER_OFFLINE',
      'DOWNLOAD_FAILED',
      'UNSUPPORTED_DOCUMENT',
      'CUPS_ERROR',
      'TIMEOUT',
      'PRINT_WINDOW_EXPIRED',
      'UNKNOWN'
    )
    .optional()
    .allow(null),
  // Accepted for the printer's own bookkeeping and correlation; the server
  // timestamps authoritatively.
  timestamp: Joi.string().isoDate().optional(),
  // The `attempt` value from the poll response this report is for.
  attempt: Joi.number().integer().min(1).optional(),
}).when(Joi.object({ status: Joi.valid('failed').required() }).unknown(), {
  then: Joi.object({
    errorCode: Joi.required().messages({
      'any.required': 'errorCode is required when reporting a failure',
    }),
  }),
});

/**
 * Printer evidence: what CUPS reported for one attempt. It is stored and never
 * changes the physical outcome. Only an operator can change that.
 */
export const jobEvidenceSchema = Joi.object({
  attempt: Joi.number().integer().min(1).required().messages({
    'any.required': 'attempt is required: the attempt this evidence belongs to',
  }),
  // Optional, so that a Pi which sends it gets a clear refusal rather than a silent drop.
  // Only 'unknown' is accepted, and the controller enforces that.
  outcome: Joi.string().max(20).optional(),
  evidence: Joi.object({
    cupsJobId: Joi.string().trim().min(1).max(200).required(),
    cupsState: Joi.string().trim().min(1).max(50).required(),
  })
    .required()
    .messages({ 'any.required': 'evidence is required' }),
  timestamp: Joi.string().isoDate().optional(),
});
