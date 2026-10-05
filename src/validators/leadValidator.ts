import Joi from 'joi';

export const createLeadSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  email: Joi.string().trim().email().max(254).required(),
  message: Joi.string().trim().min(1).max(2000).required(),
  phone: Joi.string().trim().max(20).allow(''),
  company: Joi.string().trim().max(150).allow(''),
  source: Joi.string().trim().max(50).default('web'),
  // Honeypot: hidden on the form, so only bots fill it.
  website: Joi.string().allow('').max(500),
});

export const listLeadsSchema = Joi.object({
  limit: Joi.number().integer().min(1).max(100).default(20),
  offset: Joi.number().integer().min(0).default(0),
});

export const refundJobParamsSchema = Joi.object({
  jobId: Joi.string().uuid().required(),
});

export const refundJobBodySchema = Joi.object({
  reason: Joi.string().trim().min(3).max(500).required(),
});
