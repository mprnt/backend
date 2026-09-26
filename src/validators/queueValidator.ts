import Joi from 'joi';

export const registerPrinterSchema = Joi.object({
  printerId: Joi.string().required()
    .messages({
      'any.required': 'Printer ID is required',
    }),
  kioskId: Joi.string().uuid().required()
    .messages({
      'string.guid': 'Invalid kiosk ID format',
      'any.required': 'Kiosk ID is required',
    }),
  name: Joi.string().min(1).max(255).required()
    .messages({
      'any.required': 'Printer name is required',
      'string.max': 'Printer name must be less than 255 characters',
    }),
  capabilities: Joi.object({
    supportsColor: Joi.boolean().default(false),
    supportsDoubleSided: Joi.boolean().default(false),
    maxCopies: Joi.number().integer().min(1).max(100).default(100),
    supportedPaperSizes: Joi.array().items(Joi.string()).default(['a4']),
  }).required(),
  ipAddress: Joi.string().ip().optional(),
});

export const heartbeatSchema = Joi.object({
  printerId: Joi.string().required()
    .messages({
      'any.required': 'Printer ID is required',
    }),
  status: Joi.string().valid('online', 'offline', 'busy', 'error', 'maintenance').required()
    .messages({
      'any.required': 'Status is required',
      'any.only': 'Invalid printer status',
    }),
  currentJobId: Joi.string().uuid().optional(),
  errorMessage: Joi.string().optional(),
  paperLevel: Joi.number().integer().min(0).max(100).optional(),
  inkLevel: Joi.object({
    black: Joi.number().integer().min(0).max(100).optional(),
    color: Joi.number().integer().min(0).max(100).optional(),
  }).optional(),
});

export const pollQueueSchema = Joi.object({
  printerId: Joi.string().required()
    .messages({
      'any.required': 'Printer ID is required',
    }),
  capabilities: Joi.object({
    supportsColor: Joi.boolean().required(),
    supportsDoubleSided: Joi.boolean().required(),
    maxCopies: Joi.number().integer().min(1).max(100).required(),
    supportedPaperSizes: Joi.array().items(Joi.string()).required(),
  }).required(),
});

export const updateJobStatusSchema = Joi.object({
  status: Joi.string().valid('queued', 'assigned', 'printing', 'completed', 'failed', 'cancelled').required()
    .messages({
      'any.required': 'Status is required',
      'any.only': 'Invalid job status',
    }),
  errorMessage: Joi.string().optional(),
  printedPages: Joi.number().integer().min(0).optional(),
});
