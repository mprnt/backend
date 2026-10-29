import Joi from 'joi';
import { BUSINESS_MODEL_IDS } from '../types/businessModels';
import { BUSINESS_TYPES, INDIAN_STATES } from '../services/onboardingRules';
import { payoutFields } from './adminValidator';

/**
 * Shape checks for the onboarding wizard. Formats (GSTIN, PAN, pincode, mobile)
 * are checked when a draft is completed, with the reason in the message. Here the
 * job is to refuse anything that is the wrong type or too long, and to refuse
 * unknown keys, so a field name typo cannot silently do nothing.
 */

const uuid = Joi.string().uuid();
const text = (max: number) => Joi.string().trim().max(max).allow('', null);

export const draftParamSchema = Joi.object({
  draftId: uuid.required(),
});

export const draftDocumentParamSchema = Joi.object({
  draftId: uuid.required(),
  docId: uuid.required(),
});

export const draftPatchSchema = Joi.object({
  version: Joi.number().integer().min(1).required(),
  patch: Joi.object({
    business: Joi.object({
      legalName: text(255),
      tradingName: text(255),
      businessType: Joi.string()
        .valid(...BUSINESS_TYPES)
        .allow('', null),
      addressLine1: text(255),
      addressLine2: text(255),
      city: text(120),
      state: Joi.string()
        .valid(...INDIAN_STATES)
        .allow('', null),
      pincode: Joi.string()
        .pattern(/^[0-9]{0,6}$/)
        .allow('', null),
      contactName: text(120),
      contactPhone: text(20),
      billingEmail: Joi.string().trim().email().max(255).allow('', null),
      gstRegistered: Joi.boolean().allow(null),
      gstNumber: Joi.string().trim().uppercase().max(15).allow('', null),
      pan: Joi.string().trim().uppercase().max(10).allow('', null),
      notes: text(2000),
    }).unknown(false),
    model: Joi.object({
      businessModel: Joi.string()
        .valid(...BUSINESS_MODEL_IDS)
        .allow('', null),
    }).unknown(false),
    terms: Joi.object({
      partnerSharePct: Joi.number().min(0).max(100).precision(2).allow(null),
      startsOn: Joi.string()
        .pattern(/^\d{4}-\d{2}-\d{2}$/)
        .allow('', null),
      note: text(500),
    }).unknown(false),
    qrPoint: Joi.object({
      code: Joi.string().trim().max(10).allow('', null),
      name: text(255),
      location: text(255),
      paperSizes: Joi.array()
        .items(Joi.string().valid('a4', 'a5', 'letter', 'legal'))
        .max(4),
    })
      .unknown(false)
      .allow(null),
    owner: Joi.object({
      fullName: text(120),
      email: Joi.string().trim().email().max(255).allow('', null),
      phone: text(20),
    }).unknown(false),
    // Optional: a shop can be created without bank or UPI details and add them later.
    payout: Joi.object(payoutFields).unknown(false),
  })
    .unknown(false)
    .required(),
});

export const documentKindSchema = Joi.object({
  kind: Joi.string().valid('gst_certificate', 'agreement', 'other').required(),
}).unknown(true);

export const partnerDocumentParamSchema = Joi.object({
  id: uuid.required(),
  docId: uuid.required(),
});
