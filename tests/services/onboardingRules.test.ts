import {
  checkGstin,
  completionProblems,
  gstCheckCharacter,
  isOnboardableModel,
  isValidMobile,
  isValidPan,
  isValidPincode,
  sniffDocument,
  DraftPayload,
  GST_STATE_CODES,
  INDIAN_STATES,
} from '../../src/services/onboardingRules';

// Published example GSTINs whose check character has been verified against the algorithm.
const GST_MAHARASHTRA = '27AAPFU0939F1ZV';
const GST_DELHI = '07AAGFF2194N1Z1';

const complete = (over: Partial<DraftPayload> = {}): DraftPayload => ({
  business: {
    legalName: 'Shree Print House Pvt Ltd',
    tradingName: 'Shree Print House',
    businessType: 'stationery',
    addressLine1: '12 MG Road',
    city: 'Indore',
    state: 'Madhya Pradesh',
    pincode: '452001',
    contactName: 'Rajesh Kumar',
    contactPhone: '9876543210',
    billingEmail: 'accounts@shree.test',
    gstRegistered: false,
  },
  model: { businessModel: 'integration' },
  qrPoint: null,
  owner: { fullName: 'Rajesh Kumar', email: 'owner@shree.test' },
  ...over,
});

describe('GSTIN', () => {
  it('computes the check character the GST system uses, against published examples', () => {
    expect(gstCheckCharacter(GST_MAHARASHTRA.slice(0, 14))).toBe('V');
    expect(gstCheckCharacter(GST_DELHI.slice(0, 14))).toBe('1');
  });

  it('accepts a GSTIN whose check character is right', () => {
    expect(checkGstin(GST_MAHARASHTRA)).toEqual({ ok: true, stateCode: '27', pan: 'AAPFU0939F' });
  });

  it('refuses a GSTIN with a wrong check character', () => {
    const typo = GST_MAHARASHTRA.slice(0, 14) + 'W';
    const result = checkGstin(typo);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not check out/);
  });

  it('refuses a GSTIN of the wrong shape', () => {
    expect(checkGstin('27AAPFU0939F1Z').ok).toBe(false);
    expect(checkGstin('27aapfu0939f1zv').ok).toBe(false);
    expect(checkGstin('AAPFU0939F1ZV27').ok).toBe(false);
  });

  it('has a state code for every state the form offers, and no two states share one', () => {
    for (const state of INDIAN_STATES) {
      expect(GST_STATE_CODES[state]).toMatch(/^\d{2}$/);
    }
    expect(new Set(Object.values(GST_STATE_CODES)).size).toBe(Object.keys(GST_STATE_CODES).length);
  });
});

describe('PAN, pincode, mobile', () => {
  it('checks the shapes', () => {
    expect(isValidPan('AAPFU0939F')).toBe(true);
    expect(isValidPan('aapfu0939f')).toBe(false);
    expect(isValidPincode('452001')).toBe(true);
    expect(isValidPincode('052001')).toBe(false);
    expect(isValidPincode('45200')).toBe(false);
    expect(isValidMobile('9876543210')).toBe(true);
    expect(isValidMobile('+91 9876543210')).toBe(true);
    expect(isValidMobile('5876543210')).toBe(false);
    expect(isValidMobile('98765')).toBe(false);
  });
});

describe('document signature', () => {
  it('recognises PDF, PNG and JPEG from their first bytes', () => {
    expect(sniffDocument(Buffer.from('%PDF-1.7 rest'))).toBe('pdf');
    expect(sniffDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(
      'png'
    );
    expect(sniffDocument(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('refuses a text file renamed to a PDF, or anything else', () => {
    expect(sniffDocument(Buffer.from('this is not a pdf'))).toBeNull();
    expect(sniffDocument(Buffer.from('<html>'))).toBeNull();
    expect(sniffDocument(Buffer.alloc(0))).toBeNull();
  });
});

describe('models that can be onboarded now', () => {
  it('allows Model 1 and Model 2A, and holds back 2B and 3', () => {
    expect(isOnboardableModel('integration')).toBe(true);
    expect(isOnboardableModel('revenue-share')).toBe(true);
    expect(isOnboardableModel('own-station')).toBe(false);
    expect(isOnboardableModel('full-purchase')).toBe(false);
    expect(isOnboardableModel('made-up')).toBe(false);
  });
});

describe('completionProblems', () => {
  it('an unregistered Model 1 partner with a complete form is ready', () => {
    expect(completionProblems(complete(), [])).toEqual([]);
  });

  it('a GST-registered partner needs its GSTIN and its certificate', () => {
    const p = complete({
      business: {
        ...complete().business,
        gstRegistered: true,
        state: 'Maharashtra',
        gstNumber: GST_MAHARASHTRA,
      },
    });
    const withoutDoc = completionProblems(p, []);
    expect(withoutDoc.map((x) => x.field)).toEqual(['documents.gst_certificate']);
    expect(completionProblems(p, ['gst_certificate'])).toEqual([]);
  });

  it('a registered partner with no GSTIN is told so', () => {
    const p = complete({ business: { ...complete().business, gstRegistered: true } });
    expect(completionProblems(p, ['gst_certificate']).map((x) => x.field)).toContain(
      'business.gstNumber'
    );
  });

  it('a GSTIN from another state is refused, with the state it does belong to', () => {
    const p = complete({
      business: {
        ...complete().business,
        gstRegistered: true,
        state: 'Delhi',
        gstNumber: GST_MAHARASHTRA,
      },
    });
    const problem = completionProblems(p, ['gst_certificate']).find(
      (x) => x.field === 'business.gstNumber'
    );
    expect(problem?.message).toMatch(/another state/);
  });

  it('an unregistered partner that gives a GSTIN is refused, not silently accepted', () => {
    const p = complete({
      business: { ...complete().business, gstRegistered: false, gstNumber: GST_MAHARASHTRA },
    });
    expect(completionProblems(p, []).map((x) => x.field)).toContain('business.gstNumber');
  });

  it('a PAN that disagrees with the GSTIN is refused', () => {
    const p = complete({
      business: {
        ...complete().business,
        gstRegistered: true,
        state: 'Maharashtra',
        gstNumber: GST_MAHARASHTRA,
        pan: 'ABCDE1234F',
      },
    });
    expect(completionProblems(p, ['gst_certificate']).map((x) => x.field)).toContain(
      'business.pan'
    );
  });

  it('the GST question itself must be answered', () => {
    const b = { ...complete().business };
    delete b.gstRegistered;
    expect(completionProblems(complete({ business: b }), []).map((x) => x.field)).toContain(
      'business.gstRegistered'
    );
  });

  it('a model that is not yet available is refused', () => {
    const p = complete({ model: { businessModel: 'own-station' } });
    expect(completionProblems(p, []).map((x) => x.field)).toContain('model.businessModel');
  });

  it('a 2A partner needs a share between 0 and 100, and a note of what was agreed', () => {
    const p = complete({
      model: { businessModel: 'revenue-share' },
      terms: { partnerSharePct: 140, note: '' },
    });
    const fields = completionProblems(p, []).map((x) => x.field);
    expect(fields).toEqual(expect.arrayContaining(['terms.partnerSharePct', 'terms.note']));
  });

  it('a QR point, if given, needs a valid code, name and location', () => {
    const p = complete({ qrPoint: { code: 'bad code!', name: '', location: '' } });
    expect(completionProblems(p, []).map((x) => x.field)).toEqual(
      expect.arrayContaining(['qrPoint.code', 'qrPoint.name', 'qrPoint.location'])
    );
  });

  it('the owner needs a name and an email', () => {
    const p = complete({ owner: { fullName: '', email: '' } });
    expect(completionProblems(p, []).map((x) => x.field)).toEqual(
      expect.arrayContaining(['owner.fullName', 'owner.email'])
    );
  });

  it('a state not on the list is refused', () => {
    const p = complete({ business: { ...complete().business, state: 'Narnia' } });
    expect(completionProblems(p, []).map((x) => x.field)).toContain('business.state');
  });
});
