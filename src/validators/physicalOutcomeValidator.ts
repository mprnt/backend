import Joi from 'joi';

/** Operator-recorded outcomes. The printer can never set these. */
export const PHYSICAL_OUTCOMES = ['printed', 'partial', 'blank', 'not_printed'] as const;

/** What the operator concluded about one attempt. */
export const ATTEMPT_FINDINGS = [
  'never_submitted',
  'cups_completed_printed',
  'cups_completed_partial',
  'cups_completed_blank',
  'cups_failed',
  'unknown',
] as const;

export const operatorOutcomeSchema = Joi.object({
  outcome: Joi.string()
    .valid(...PHYSICAL_OUTCOMES)
    .required()
    .messages({ 'any.only': 'outcome must be printed, partial, blank or not_printed' }),
  // Verified in the same units as printed pages: total pages across all copies.
  // Null is refused by the service for every outcome, so the count is always a fact.
  verifiedPages: Joi.number().integer().min(0).max(10000).allow(null).required().messages({
    'any.required': 'verifiedPages is required: the pages you counted, or 0',
  }),
  method: Joi.string().trim().min(3).max(100).required().messages({
    'any.required': 'method is required, e.g. "physical inspection"',
  }),
  reason: Joi.string().trim().min(10).max(1000).required().messages({
    'any.required': 'reason is required',
    'string.min': 'reason must say what was checked (at least 10 characters)',
  }),
  attemptFindings: Joi.array()
    .items(
      Joi.object({
        attempt: Joi.number().integer().min(1).max(10000).required(),
        printerId: Joi.string().uuid().allow(null).required(),
        finding: Joi.string()
          .valid(...ATTEMPT_FINDINGS)
          .required(),
      })
    )
    .max(10000)
    .required()
    .messages({ 'any.required': 'attemptFindings is required: one entry per attempt' }),
});
