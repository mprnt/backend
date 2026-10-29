/**
 * Partner onboarding: the rules that decide whether a partner can be created.
 *
 * Pure functions, so every rule can be tested without a database. The service
 * calls these before it writes anything, and the database repeats the important
 * ones (GST format, one partner per GSTIN) as a second line of defence.
 */

export const BUSINESS_TYPES = [
  'stationery',
  'cyber_cafe',
  'photocopy',
  'college',
  'library',
  'office',
  'other',
] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

/** Indian states and union territories, by the name the form shows. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

/**
 * The two-digit state code at the front of a GSTIN, for each state. A GSTIN must
 * carry the code of the state the business is in, or the registration is wrong.
 */
export const GST_STATE_CODES: Record<string, string> = {
  'Jammu and Kashmir': '01',
  'Himachal Pradesh': '02',
  Punjab: '03',
  Chandigarh: '04',
  Uttarakhand: '05',
  Haryana: '06',
  Delhi: '07',
  Rajasthan: '08',
  'Uttar Pradesh': '09',
  Bihar: '10',
  Sikkim: '11',
  'Arunachal Pradesh': '12',
  Nagaland: '13',
  Manipur: '14',
  Mizoram: '15',
  Tripura: '16',
  Meghalaya: '17',
  Assam: '18',
  'West Bengal': '19',
  Jharkhand: '20',
  Odisha: '21',
  Chhattisgarh: '22',
  'Madhya Pradesh': '23',
  Gujarat: '24',
  'Dadra and Nagar Haveli and Daman and Diu': '26',
  Maharashtra: '27',
  Karnataka: '29',
  Goa: '30',
  Lakshadweep: '31',
  Kerala: '32',
  'Tamil Nadu': '33',
  Puducherry: '34',
  'Andaman and Nicobar Islands': '35',
  Telangana: '36',
  'Andhra Pradesh': '37',
  Ladakh: '38',
};

const GST_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const PAN_SHAPE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const PINCODE_SHAPE = /^[1-9][0-9]{5}$/;
const MOBILE_SHAPE = /^(\+91[ -]?)?[6-9][0-9]{9}$/;

/**
 * The GSTIN check character, as the GST system computes it: each of the first
 * 14 characters is weighted 1 or 2 by position, the digits of each product are
 * summed, and the total is subtracted from the next multiple of 36.
 */
export function gstCheckCharacter(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const value = GST_CHARS.indexOf(first14[i]);
    const product = value * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GST_CHARS[(36 - (sum % 36)) % 36];
}

export interface GstinCheck {
  ok: boolean;
  reason?: string;
  stateCode?: string;
  pan?: string;
}

/** A GSTIN: shape, check character, and a PAN embedded in it that is itself well formed. */
export function checkGstin(gstin: string): GstinCheck {
  if (!GSTIN_SHAPE.test(gstin)) {
    return {
      ok: false,
      reason:
        'A GST number is 15 characters: two digits, five letters, four digits, a letter, then a digit or letter, Z, and a check character',
    };
  }
  if (gstCheckCharacter(gstin.slice(0, 14)) !== gstin[14]) {
    return {
      ok: false,
      reason: 'The GST number does not check out. Re-read it from the certificate',
    };
  }
  return { ok: true, stateCode: gstin.slice(0, 2), pan: gstin.slice(2, 12) };
}

export function isValidPan(pan: string): boolean {
  return PAN_SHAPE.test(pan);
}

export function isValidPincode(pincode: string): boolean {
  return PINCODE_SHAPE.test(pincode);
}

export function isValidMobile(phone: string): boolean {
  return MOBILE_SHAPE.test(phone.replace(/\s+/g, ''));
}

export type DocumentKind = 'pdf' | 'png' | 'jpeg';

/**
 * What a file really is, from its first bytes. The client's claimed MIME type is
 * not trusted: a text file renamed to .pdf is refused here.
 */
export function sniffDocument(bytes: Buffer): DocumentKind | null {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'jpeg';
  return null;
}

export const DOCUMENT_CONTENT_TYPE: Record<DocumentKind, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
};

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** The business models a partner can be onboarded onto now. 2B and 3 come later. */
export const ONBOARDABLE_MODELS = ['integration', 'revenue-share'] as const;
export type OnboardableModel = (typeof ONBOARDABLE_MODELS)[number];

export function isOnboardableModel(value: string): value is OnboardableModel {
  return (ONBOARDABLE_MODELS as readonly string[]).includes(value);
}

/**
 * The fields a draft must have before it can become a partner, and what is
 * missing from it. An empty list means it is ready.
 */
export interface DraftPayload {
  business?: {
    legalName?: string;
    tradingName?: string;
    businessType?: BusinessType;
    addressLine1?: string;
    addressLine2?: string | null;
    city?: string;
    state?: string;
    pincode?: string;
    contactName?: string;
    contactPhone?: string;
    billingEmail?: string;
    gstRegistered?: boolean;
    gstNumber?: string | null;
    pan?: string | null;
    notes?: string | null;
  };
  model?: { businessModel?: string };
  terms?: {
    partnerSharePct?: number;
    startsOn?: string | null;
    note?: string;
  };
  qrPoint?: {
    code?: string;
    name?: string;
    location?: string;
    paperSizes?: string[];
  } | null;
  owner?: {
    fullName?: string;
    email?: string;
    phone?: string | null;
  };
  /**
   * Bank and UPI, optional. The account number is never kept in clear in a draft: a draft
   * holds its last four digits and an encrypted copy, and only the last four are returned.
   */
  payout?: {
    bankAccountHolder?: string;
    bankName?: string;
    bankIfsc?: string;
    upiId?: string;
    bankAccountLast4?: string;
    bankAccountNumberEnc?: string;
  };
}

export interface DraftProblem {
  field: string;
  message: string;
}

export function completionProblems(payload: DraftPayload, documentKinds: string[]): DraftProblem[] {
  const problems: DraftProblem[] = [];
  const b = payload.business ?? {};

  const need = (field: string, value: unknown, message = 'Required') => {
    if (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    ) {
      problems.push({ field, message });
    }
  };

  need('business.legalName', b.legalName);
  need('business.tradingName', b.tradingName);
  need('business.businessType', b.businessType);
  need('business.addressLine1', b.addressLine1);
  need('business.city', b.city);
  need('business.state', b.state);
  need('business.pincode', b.pincode);
  need('business.contactName', b.contactName);
  need('business.contactPhone', b.contactPhone);
  need('business.billingEmail', b.billingEmail);

  if (b.state && !(INDIAN_STATES as readonly string[]).includes(b.state)) {
    problems.push({ field: 'business.state', message: 'Choose a state from the list' });
  }
  if (b.pincode && !isValidPincode(b.pincode)) {
    problems.push({
      field: 'business.pincode',
      message: 'A pincode is six digits and does not start with 0',
    });
  }
  if (b.contactPhone && !isValidMobile(b.contactPhone)) {
    problems.push({ field: 'business.contactPhone', message: 'Enter a 10-digit mobile number' });
  }

  // GST: a registered business must give its GSTIN and its certificate. An
  // unregistered one must say so and give no number.
  if (b.gstRegistered === undefined) {
    problems.push({
      field: 'business.gstRegistered',
      message: 'Say whether the business is GST-registered',
    });
  } else if (b.gstRegistered) {
    need('business.gstNumber', b.gstNumber, 'A GST-registered business needs its GST number');
    if (b.gstNumber) {
      const check = checkGstin(b.gstNumber);
      if (!check.ok) {
        problems.push({
          field: 'business.gstNumber',
          message: check.reason ?? 'Invalid GST number',
        });
      } else if (b.state && GST_STATE_CODES[b.state] !== check.stateCode) {
        problems.push({
          field: 'business.gstNumber',
          message: `This GST number is for another state. ${b.state} starts with ${GST_STATE_CODES[b.state] ?? '—'}`,
        });
      }
      if (b.pan && check.pan && b.pan !== check.pan) {
        problems.push({ field: 'business.pan', message: 'The PAN does not match the GST number' });
      }
    }
    if (!documentKinds.includes('gst_certificate')) {
      problems.push({ field: 'documents.gst_certificate', message: 'Upload the GST certificate' });
    }
  } else if (b.gstNumber) {
    problems.push({
      field: 'business.gstNumber',
      message: 'Remove the GST number, or mark the business as registered',
    });
  }
  if (b.pan && !isValidPan(b.pan)) {
    problems.push({
      field: 'business.pan',
      message: 'A PAN is five letters, four digits, then a letter',
    });
  }

  const model = payload.model?.businessModel;
  if (!model) {
    problems.push({ field: 'model.businessModel', message: 'Choose the business model' });
  } else if (!isOnboardableModel(model)) {
    problems.push({
      field: 'model.businessModel',
      message: 'This model is not available to onboard yet',
    });
  } else if (model === 'revenue-share') {
    const t = payload.terms ?? {};
    if (t.partnerSharePct === undefined || t.partnerSharePct === null) {
      problems.push({
        field: 'terms.partnerSharePct',
        message: 'Set the partner’s share of revenue',
      });
    } else if (t.partnerSharePct < 0 || t.partnerSharePct > 100) {
      problems.push({
        field: 'terms.partnerSharePct',
        message: 'The share must be between 0 and 100',
      });
    }
    if (!t.note || t.note.trim().length < 3) {
      problems.push({
        field: 'terms.note',
        message: 'Write down what was agreed (at least 3 characters)',
      });
    }
  }

  if (payload.qrPoint) {
    const q = payload.qrPoint;
    if (!q.code || !/^[A-Za-z0-9-]{2,10}$/.test(q.code)) {
      problems.push({
        field: 'qrPoint.code',
        message: 'A QR code is 2 to 10 letters, digits or hyphens',
      });
    }
    need('qrPoint.name', q.name);
    need('qrPoint.location', q.location);
  }

  const o = payload.owner ?? {};
  need('owner.fullName', o.fullName);
  need('owner.email', o.email, 'The owner needs an email to sign in');
  if (o.phone && !isValidMobile(o.phone)) {
    problems.push({ field: 'owner.phone', message: 'Enter a 10-digit mobile number' });
  }

  return problems;
}
