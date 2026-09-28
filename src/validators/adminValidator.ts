import Joi from 'joi';
import { ASSIGNABLE_ROLES, PERMISSIONS } from '../types/admin';

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
}).custom((value, helpers) => {
  if (value.currentPassword === value.newPassword) {
    return helpers.error('any.invalid', {
      message: 'New password must differ from the current one',
    });
  }
  return value;
});

export const createOrganizationSchema = Joi.object({
  name: Joi.string().min(2).max(255).required(),
  timezone: Joi.string().max(64).default('Asia/Kolkata'),
  contactEmail: email().optional().allow(null, ''),
  contactPhone: Joi.string().max(32).optional().allow(null, ''),
  notes: Joi.string().max(2000).optional().allow(null, ''),
});

export const updateOrganizationSchema = Joi.object({
  name: Joi.string().min(2).max(255).optional(),
  timezone: Joi.string().max(64).optional(),
  contactEmail: email().optional().allow(null, ''),
  contactPhone: Joi.string().max(32).optional().allow(null, ''),
  notes: Joi.string().max(2000).optional().allow(null, ''),
}).min(1);

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

export const reportQuerySchema = Joi.object({
  organizationId: uuid.optional(),
  kioskId: uuid.optional(),
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
