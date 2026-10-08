import Joi from 'joi';
import { ASSIGNABLE_ROLES, PERMISSIONS } from '../types/admin';
import { BUSINESS_MODEL_IDS } from '../types/businessModels';

const uuid = Joi.string().uuid();

/**
 * Joi checks the TLD against a bundled IANA list by default, which rejects both
 * reserved test domains and any gTLD newer than the installed copy. Structure is
 * what matters here; deliverability is proven by the invite, not by a list.
 */
const email = () =>
  Joi.string()
    .email({ tlds: { allow: false } })
    .max(255);

export const loginSchema = Joi.object({
  email: email().required(),
  password: Joi.string().min(1).max(200).required(),
});

export const refreshSchema = Joi.object({
  refreshToken: Joi.string().min(10).max(500).required(),
});

export const changePasswordSchema = Joi.object({
  currentPassword: Joi.string().min(1).max(200).required(),
  // Length beats composition rules for real-world strength, and these accounts
  // are created with a generated password anyway.
  newPassword: Joi.string().min(12).max(200).required().messages({
    'string.min': 'New password must be at least 12 characters',
  }),
}).custom((value: { currentPassword: string; newPassword: string }, helpers) => {
  if (value.currentPassword === value.newPassword) {
    return helpers.error('any.invalid', {
      message: 'New password must differ from the current one',
    });
  }
  return value;
});

export const createOrganizationSchema = Joi.object({
  name: Joi.string().min(2).max(255).required(),
  // Optional: a partner can be created before the commercial terms are signed.
  businessModel: Joi.string()
    .valid(...BUSINESS_MODEL_IDS)
    .optional()
    .allow(null, ''),
  timezone: Joi.string().max(64).default('Asia/Kolkata'),
  contactEmail: email().optional().allow(null, ''),
  contactPhone: Joi.string().max(32).optional().allow(null, ''),
  notes: Joi.string().max(2000).optional().allow(null, ''),
});

export const updateOrganizationSchema = Joi.object({
  name: Joi.string().min(2).max(255).optional(),
  businessModel: Joi.string()
    .valid(...BUSINESS_MODEL_IDS)
    .optional()
    .allow(null, ''),
  timezone: Joi.string().max(64).optional(),
  contactEmail: email().optional().allow(null, ''),
  contactPhone: Joi.string().max(32).optional().allow(null, ''),
  notes: Joi.string().max(2000).optional().allow(null, ''),
}).min(1);

/**
 * Query for GET /organizations. An unknown model id is rejected rather than
 * quietly returning an empty list, which would read as "no partners on that
 * model" when it was really a typo.
 */
export const listOrganizationsQuerySchema = Joi.object({
  status: Joi.string().valid('active', 'suspended').optional(),
  search: Joi.string().max(255).optional().allow(''),
  businessModel: Joi.string()
    .valid(...BUSINESS_MODEL_IDS, 'none')
    .optional()
    .allow(''),
});

export const organizationStatusSchema = Joi.object({
  status: Joi.string().valid('active', 'suspended').required(),
});

export const assignKioskSchema = Joi.object({
  kioskId: uuid.required(),
});

export const createAdminSchema = Joi.object({
  email: email().required(),
  fullName: Joi.string().max(255).optional().allow(null, ''),
  role: Joi.string()
    .valid(...ASSIGNABLE_ROLES)
    .required()
    .messages({
      'any.only': `Role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
    }),
  organizationId: uuid.required(),
});

export const updateAdminSchema = Joi.object({
  fullName: Joi.string().max(255).optional().allow(null, ''),
  role: Joi.string()
    .valid(...ASSIGNABLE_ROLES)
    .optional(),
  isActive: Joi.boolean().optional(),
}).min(1);

export const permissionOverrideSchema = Joi.object({
  permission: Joi.string()
    .valid(...Object.values(PERMISSIONS))
    .required(),
  effect: Joi.string().valid('grant', 'deny', 'inherit').required(),
});

export const createPriceListSchema = Joi.object({
  organizationId: uuid.optional().allow(null),
  kioskId: uuid.optional().allow(null),
  bwPerPage: Joi.number().min(0).max(10000).required(),
  colorPerPage: Joi.number().min(0).max(10000).required(),
  minCharge: Joi.number().min(0).max(10000).default(0),
  effectiveFrom: Joi.string().isoDate().optional(),
})
  // A kiosk-scoped price needs its organization so resolution is unambiguous.
  .with('kioskId', 'organizationId');

const printerIdentifier = Joi.string()
  .pattern(/^[A-Za-z0-9_-]{3,64}$/)
  .messages({
    'string.pattern.base':
      'Printer ID must be 3–64 letters, digits, underscores or hyphens (e.g. RPI_M002_01)',
  });

export const reportQuerySchema = Joi.object({
  organizationId: uuid.optional(),
  kioskId: uuid.optional(),
  printerId: printerIdentifier.optional(),
  period: Joi.string().valid('day', 'week', 'month', 'year').default('month'),
  from: Joi.string().isoDate().optional(),
  to: Joi.string().isoDate().optional(),
  bucket: Joi.string().valid('day', 'week', 'month', 'year').optional(),
  status: Joi.string()
    .valid('pending', 'queued', 'printing', 'completed', 'failed', 'cancelled')
    .optional(),
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
})
  // Ranges are given either as a named period or as an explicit pair.
  .and('from', 'to');

export const idParamSchema = Joi.object({
  id: uuid.required(),
});

// ---------------------------------------------------------------------------
// Kiosks, printers, platform reports, audit
// ---------------------------------------------------------------------------

/** Matches kiosks.kiosk_id, which is VARCHAR(10). */
const kioskCode = Joi.string()
  .pattern(/^[A-Za-z0-9-]{2,10}$/)
  .messages({
    'string.pattern.base': 'Kiosk code must be 2–10 letters, digits or hyphens (e.g. M002)',
  });

const printerCapabilities = Joi.object({
  supportsColor: Joi.boolean().required(),
  supportsDoubleSided: Joi.boolean().required(),
  maxCopies: Joi.number().integer().min(1).max(100).required(),
  supportedPaperSizes: Joi.array().items(Joi.string().max(20)).min(1).max(20).required(),
});

export const createKioskSchema = Joi.object({
  kioskCode: kioskCode.required(),
  name: Joi.string().min(1).max(255).required(),
  location: Joi.string().min(1).max(255).required(),
  organizationId: uuid.required(),
  capabilities: Joi.object({
    color: Joi.boolean(),
    duplex: Joi.boolean(),
    paperSizes: Joi.array().items(Joi.string().max(20)).min(1).max(20),
  }).optional(),
});

export const updateKioskSchema = Joi.object({
  name: Joi.string().min(1).max(255),
  location: Joi.string().min(1).max(255),
  // 'offline' is deliberately absent: that is a state the system observes,
  // not one an operator sets.
  status: Joi.string().valid('active', 'inactive', 'maintenance'),
}).min(1);

export const adminEnrollPrinterSchema = Joi.object({
  printerId: printerIdentifier.required(),
  kioskId: uuid.required(),
  name: Joi.string().min(1).max(255).required(),
  capabilities: printerCapabilities.required(),
  // A station is one printer in an MPrnt enclosure, so it is a flag on the
  // printer rather than an object of its own.
  isStation: Joi.boolean().default(false),
  stationName: Joi.string().max(100).optional().allow(null, ''),
});

export const updatePrinterSchema = Joi.object({
  name: Joi.string().min(1).max(255).optional(),
  isStation: Joi.boolean().optional(),
  stationName: Joi.string().max(100).optional().allow(null, ''),
}).min(1);

export const printerParamSchema = Joi.object({
  printerId: printerIdentifier.required(),
});

export const periodQuerySchema = Joi.object({
  period: Joi.string().valid('day', 'week', 'month', 'year').default('month'),
});

export const auditQuerySchema = Joi.object({
  organizationId: uuid.optional(),
  actorScope: Joi.string().valid('platform', 'shop').optional(),
  category: Joi.string().valid('all', 'security').default('all'),
  action: Joi.string().max(64).optional(),
  from: Joi.string().isoDate().optional(),
  to: Joi.string().isoDate().optional(),
  limit: Joi.number().integer().min(1).max(200).default(50),
  offset: Joi.number().integer().min(0).default(0),
});
