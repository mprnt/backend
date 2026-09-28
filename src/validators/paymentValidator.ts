import Joi from 'joi';

export const createPaymentOrderSchema = Joi.object({
  jobId: Joi.string().uuid().required().messages({
    'string.guid': 'Invalid job ID format',
    'any.required': 'Job ID is required',
  }),
});

export const verifyPaymentSchema = Joi.object({
  orderId: Joi.string().required().messages({
    'any.required': 'Order ID is required',
  }),
  paymentId: Joi.string().required().messages({
    'any.required': 'Payment ID is required',
  }),
  signature: Joi.string().required().messages({
    'any.required': 'Payment signature is required',
  }),
});

export const getPaymentOrderSchema = Joi.object({
  orderId: Joi.string().required().messages({
    'any.required': 'Order ID is required',
  }),
});

export const simulatePaymentSchema = Joi.object({
  orderId: Joi.string().required().messages({
    'any.required': 'Order ID is required',
  }),
  errorCode: Joi.string().optional(),
});

export const paymentFailureSchema = Joi.object({
  orderId: Joi.string().required().messages({
    'any.required': 'Order ID is required',
  }),
  errorCode: Joi.string().required().messages({
    'any.required': 'Error code is required',
  }),
  errorDescription: Joi.string().required().messages({
    'any.required': 'Error description is required',
  }),
});
