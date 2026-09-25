import Joi from 'joi';

// POST /api/v1/sessions - Create new session
export const createSessionSchema = Joi.object({
  kioskId: Joi.string().required().messages({
    'string.empty': 'Kiosk ID is required',
    'any.required': 'Kiosk ID is required',
  }),
});

// GET /api/v1/sessions/:sessionId - Get session
export const getSessionSchema = Joi.object({
  sessionId: Joi.string().required().messages({
    'string.empty': 'Session ID is required',
    'any.required': 'Session ID is required',
  }),
});

// DELETE /api/v1/sessions/:sessionId - Cancel session
export const cancelSessionSchema = Joi.object({
  sessionId: Joi.string().required().messages({
    'string.empty': 'Session ID is required',
    'any.required': 'Session ID is required',
  }),
});

// GET /api/v1/sessions - List sessions with filtering
export const listSessionsSchema = Joi.object({
  status: Joi.string().valid('draft', 'complete', 'expired').optional(),
  kioskId: Joi.string().min(1).max(50).optional(),
  limit: Joi.number().integer().min(1).max(100).optional(),
  offset: Joi.number().integer().min(0).optional(),
});
