import Joi from 'joi';

export const printSettingsSchema = Joi.object({
  colorMode: Joi.string().valid('bw', 'color').required().messages({
    'any.required': 'Color mode is required',
    'any.only': 'Color mode must be either "bw" or "color"',
  }),

  copies: Joi.number().integer().min(1).max(100).default(1).messages({
    'number.base': 'Copies must be a number',
    'number.min': 'Copies must be at least 1',
    'number.max': 'Copies cannot exceed 100',
  }),

  pageRange: Joi.string().valid('all', 'custom').default('all').messages({
    'any.only': 'Page range must be either "all" or "custom"',
  }),

  customRange: Joi.string()
    .when('pageRange', {
      is: 'custom',
      then: Joi.required(),
      otherwise: Joi.forbidden(),
    })
    .messages({
      'any.required': 'Custom range is required when page range is "custom"',
      'any.unknown': 'Custom range should not be provided when page range is "all"',
    }),

  printSides: Joi.string().valid('single', 'double').default('single').messages({
    'any.only': 'Print sides must be either "single" or "double"',
  }),

  paperSize: Joi.string().valid('a4', 'letter').default('a4').messages({
    'any.only': 'Paper size must be either "a4" or "letter"',
  }),

  orientation: Joi.string().valid('portrait', 'landscape').default('portrait').messages({
    'any.only': 'Orientation must be either "portrait" or "landscape"',
  }),
});

export const createPrintJobSchema = Joi.object({
  colorMode: Joi.string().valid('bw', 'color').required(),
  copies: Joi.number().integer().min(1).max(100).default(1),
  pageRange: Joi.string().valid('all', 'custom').default('all'),
  customRange: Joi.string().when('pageRange', {
    is: 'custom',
    then: Joi.required(),
    otherwise: Joi.forbidden(),
  }),
  printSides: Joi.string().valid('single', 'double').default('single'),
  paperSize: Joi.string().valid('a4', 'letter').default('a4'),
  orientation: Joi.string().valid('portrait', 'landscape').default('portrait'),
});

export const updatePrintJobSettingsSchema = Joi.object({
  colorMode: Joi.string().valid('bw', 'color').optional(),
  copies: Joi.number().integer().min(1).max(100).optional(),
  pageRange: Joi.string().valid('all', 'custom').optional(),
  customRange: Joi.string().optional(),
  printSides: Joi.string().valid('single', 'double').optional(),
  paperSize: Joi.string().valid('a4', 'letter').optional(),
  orientation: Joi.string().valid('portrait', 'landscape').optional(),
}).min(1);

export const getPrintJobSchema = Joi.object({
  jobId: Joi.string().uuid().required().messages({
    'string.guid': 'Invalid job ID format',
    'any.required': 'Job ID is required',
  }),
});

export const validateJobIdParam = (req: any, res: any, next: any): void => {
  const { jobId } = req.params;
  const { error } = Joi.string().uuid().required().validate(jobId);

  if (error) {
    res.status(400).json({
      status: 'error',
      message: 'Invalid job ID format',
      errors: [{ field: 'jobId', message: error.message }],
    });
    return;
  }

  next();
};
