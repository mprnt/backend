import { OnboardingService, DocumentStore } from '../../src/services/onboardingService';
import { AppError } from '../../src/middleware/errorHandler';
import { scriptedDb, Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const DRAFT = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';
const ADMIN = '55555555-5555-4555-8555-555555555555';
const GST = '27AAPFU0939F1ZV';
const FUTURE = new Date(Date.now() + 5 * 86_400_000);
const PAST = new Date(Date.now() - 86_400_000);

const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]);

const completePayload = (over: Record<string, unknown> = {}) => ({
  business: {
    legalName: 'Shree Print House Pvt Ltd',
    tradingName: 'Shree Print House',
    businessType: 'stationery',
    addressLine1: '12 MG Road',
    city: 'Indore',
    state: 'Maharashtra',
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

const draftRow = (over: Record<string, unknown> = {}) => ({
  id: DRAFT,
  status: 'open',
  payload: completePayload(),
  version: 3,
  expires_at: FUTURE,
  organization_id: null,
  expired: false,
  ...over,
});

const fakeStore = (): DocumentStore & {
  uploadFile: jest.Mock;
  deleteFile: jest.Mock;
  downloadFile: jest.Mock;
} => ({
  uploadFile: jest.fn(async (key: string) => key),
  downloadFile: jest.fn(async () => PDF),
  deleteFile: jest.fn(async () => undefined),
});

describe('drafts', () => {
  it('a new draft is open, empty, and says what is still missing', async () => {
    const db = scriptedDb([
      ['INSERT INTO partner_onboarding_drafts', [{ id: DRAFT }]],
      ['FROM partner_onboarding_drafts', [draftRow({ payload: {}, version: 1 })]],
    ]);
    const svc = new OnboardingService(db as never, fakeStore());
    const draft = await svc.createDraft(ADMIN);
    expect(draft.status).toBe('open');
    expect(draft.version).toBe(1);
    expect(draft.problems.length).toBeGreaterThan(0);
    expect(db.sqlFor('INSERT INTO partner_onboarding_drafts')[0].params).toEqual([ADMIN, '7']);
  });

  it('saves only the sections it is given, and bumps the version', async () => {
    const db = scriptedDb([
      ['FOR UPDATE', [draftRow({ payload: { business: { city: 'Indore' } }, version: 3 })]],
      [
        'FROM partner_onboarding_drafts',
        [draftRow({ payload: { business: { city: 'Indore', state: 'Gujarat' } }, version: 4 })],
      ],
    ]);
    const svc = new OnboardingService(db as never, fakeStore());
    await svc.patchDraft(DRAFT, 3, { business: { state: 'Gujarat' } });
    const update = db.sqlFor('SET payload')[0];
    expect(update.sql).toContain('version = version + 1');
    const saved = JSON.parse(update.params[1] as string);
    expect(saved.business).toEqual({ city: 'Indore', state: 'Gujarat' });
  });

  it('refuses a save made against an old version, rather than overwriting someone else', async () => {
    const db = scriptedDb([['FOR UPDATE', [draftRow({ version: 5 })]]]);
    const svc = new OnboardingService(db as never, fakeStore());
    const err = await svc.patchDraft(DRAFT, 3, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('VERSION_CONFLICT');
    expect(db.sqlFor('SET payload')).toHaveLength(0);
  });

  it('an expired draft cannot be saved', async () => {
    const db = scriptedDb([['FOR UPDATE', [draftRow({ expires_at: PAST, expired: true })]]]);
    const svc = new OnboardingService(db as never, fakeStore());
    await expect(svc.patchDraft(DRAFT, 3, {})).rejects.toMatchObject({
      code: 'DRAFT_EXPIRED',
      statusCode: 410,
    });
  });

  it('a draft that became a partner cannot be saved again', async () => {
    const db = scriptedDb([
      ['FOR UPDATE', [draftRow({ status: 'completed', organization_id: ORG })]],
    ]);
    const svc = new OnboardingService(db as never, fakeStore());
    await expect(svc.patchDraft(DRAFT, 3, {})).rejects.toMatchObject({
      code: 'DRAFT_COMPLETED',
    });
  });
});

describe('documents', () => {
  const upload = (bytes: Buffer, over: Record<string, unknown> = {}) => ({
    kind: 'gst_certificate',
    original: 'gst.pdf',
    claimedType: 'application/pdf',
    bytes,
    actorId: ADMIN,
    ...over,
  });

  it('stores a real PDF and records it against the draft, by its bytes', async () => {
    const store = fakeStore();
    const db = scriptedDb([
      ['FOR UPDATE', [draftRow()]],
      ['INSERT INTO partner_documents', [{ id: DOC, uploaded_at: new Date() }]],
    ]);
    const svc = new OnboardingService(db as never, store);
    const doc = await svc.addDocument(DRAFT, upload(PDF));
    expect(doc.kind).toBe('gst_certificate');
    expect(store.uploadFile).toHaveBeenCalledTimes(1);
    const key = store.uploadFile.mock.calls[0][0] as string;
    expect(key).toMatch(new RegExp(`^onboarding/${DRAFT}/.+\\.pdf$`));
    expect(store.uploadFile.mock.calls[0][2]).toBe('application/pdf');
  });

  it('refuses a text file renamed to .pdf, and stores nothing', async () => {
    const store = fakeStore();
    const svc = new OnboardingService(scriptedDb([['FOR UPDATE', [draftRow()]]]) as never, store);
    await expect(svc.addDocument(DRAFT, upload(Buffer.from('hello world')))).rejects.toMatchObject({
      code: 'DOCUMENT_TYPE_REFUSED',
    });
    expect(store.uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a file whose real type is not the type it claims', async () => {
    const store = fakeStore();
    const svc = new OnboardingService(scriptedDb([['FOR UPDATE', [draftRow()]]]) as never, store);
    await expect(
      svc.addDocument(DRAFT, upload(PDF, { claimedType: 'image/png' }))
    ).rejects.toMatchObject({ code: 'DOCUMENT_TYPE_MISMATCH' });
  });

  it('refuses a file over 5 MB and an empty file', async () => {
    const svc = new OnboardingService(
      scriptedDb([['FOR UPDATE', [draftRow()]]]) as never,
      fakeStore()
    );
    await expect(
      svc.addDocument(DRAFT, upload(Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])))
    ).rejects.toMatchObject({ code: 'DOCUMENT_TOO_LARGE', statusCode: 413 });
    await expect(svc.addDocument(DRAFT, upload(Buffer.alloc(0)))).rejects.toMatchObject({
      code: 'EMPTY_DOCUMENT',
    });
  });

  it('refuses an unknown kind of document', async () => {
    const svc = new OnboardingService(scriptedDb([]) as never, fakeStore());
    await expect(svc.addDocument(DRAFT, upload(PDF, { kind: 'passport' }))).rejects.toMatchObject({
      code: 'BAD_DOCUMENT_KIND',
    });
  });

  it('if the record cannot be saved, the file is removed, so nothing is left orphaned', async () => {
    const store = fakeStore();
    const base = scriptedDb([['FOR UPDATE', [draftRow()]]]);
    const failing = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (String(sql).includes('INSERT INTO partner_documents'))
          throw new Error('database went away');
        return base.query(sql, params);
      }),
      getClient: async () => ({
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          if (String(sql).includes('INSERT INTO partner_documents'))
            throw new Error('database went away');
          return base.client.query(sql, params);
        }),
        release: jest.fn(),
      }),
    };
    const svc = new OnboardingService(failing as never, store);
    await expect(svc.addDocument(DRAFT, upload(PDF))).rejects.toThrow('database went away');
    expect(store.deleteFile).toHaveBeenCalledWith(store.uploadFile.mock.calls[0][0]);
  });

  it('a new GST certificate replaces the old one, and the old file is removed', async () => {
    const store = fakeStore();
    const db = scriptedDb([
      ['FOR UPDATE', [draftRow()]],
      ['DELETE FROM partner_documents', [{ storage_key: 'onboarding/old.pdf' }]],
      ['INSERT INTO partner_documents', [{ id: DOC, uploaded_at: new Date() }]],
    ]);
    await new OnboardingService(db as never, store).addDocument(DRAFT, upload(PDF));
    expect(store.deleteFile).toHaveBeenCalledWith('onboarding/old.pdf');
  });

  it('removing a staged document deletes it and its file', async () => {
    const store = fakeStore();
    const db = scriptedDb([
      ['FOR UPDATE', [draftRow()]],
      ['DELETE FROM partner_documents', [{ storage_key: 'onboarding/x.pdf' }]],
    ]);
    await new OnboardingService(db as never, store).removeDocument(DRAFT, DOC);
    expect(store.deleteFile).toHaveBeenCalledWith('onboarding/x.pdf');
  });

  it('removing a document that is not on this draft is a 404', async () => {
    const db = scriptedDb([['FOR UPDATE', [draftRow()]]]);
    await expect(
      new OnboardingService(db as never, fakeStore()).removeDocument(DRAFT, DOC)
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('completion', () => {
  const completeRules = (
    over: {
      gstTaken?: boolean;
      qrTaken?: boolean;
      emailTaken?: boolean;
      payload?: unknown;
      docs?: unknown[];
    } = {}
  ): Rule[] => [
    [
      'FROM partner_onboarding_drafts',
      [draftRow({ payload: over.payload ?? completePayload(), version: 3 })],
    ],
    ['SELECT id, kind, storage_key FROM partner_documents', over.docs ?? []],
    ['WHERE gst_number = $1', over.gstTaken ? [{}] : []],
    ['FROM kiosks WHERE kiosk_id', over.qrTaken ? [{}] : []],
    ['lower(email) = lower($1) AND deleted_at', over.emailTaken ? [{}] : []],
    ['WHERE slug = $1', []],
    ['INSERT INTO organizations', [{ id: ORG }]],
    ['INSERT INTO admin_users', [{ id: OWNER }]],
    ['INSERT INTO kiosks', [{ id: 'k1' }]],
    ['INSERT INTO revenue_split_terms', []],
    ['UPDATE partner_documents SET organization_id', []],
    ['UPDATE partner_onboarding_drafts', []],
    ['INSERT INTO audit_logs', []],
  ];

  it('refuses an incomplete draft and says exactly what is missing', async () => {
    const db = scriptedDb(
      completeRules({ payload: completePayload({ owner: { fullName: '', email: '' } }) })
    );
    const err = await new OnboardingService(db as never, fakeStore())
      .complete(DRAFT, ADMIN)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('DRAFT_INCOMPLETE');
    expect(JSON.stringify((err as AppError).details)).toContain('owner.email');
    expect(db.sqlFor('INSERT INTO organizations')).toHaveLength(0);
  });

  it('a GST-registered draft with no certificate is refused', async () => {
    const payload = completePayload({
      business: {
        ...completePayload().business,
        gstRegistered: true,
        state: 'Maharashtra',
        gstNumber: GST,
      },
    });
    const db = scriptedDb(completeRules({ payload, docs: [] }));
    await expect(
      new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN)
    ).rejects.toMatchObject({ code: 'DRAFT_INCOMPLETE' });
  });

  it('refuses a GST number another partner already holds, and creates nothing', async () => {
    const payload = completePayload({
      business: {
        ...completePayload().business,
        gstRegistered: true,
        state: 'Maharashtra',
        gstNumber: GST,
      },
    });
    const db = scriptedDb(
      completeRules({
        payload,
        docs: [{ id: DOC, kind: 'gst_certificate', storage_key: 'k' }],
        gstTaken: true,
      })
    );
    await expect(
      new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN)
    ).rejects.toMatchObject({ code: 'GST_IN_USE', statusCode: 409 });
    expect(db.sqlFor('INSERT INTO organizations')).toHaveLength(0);
  });

  it('refuses a QR code already in use', async () => {
    const payload = completePayload({
      qrPoint: { code: 'SP-01', name: 'Front', location: 'Counter', paperSizes: ['a4'] },
    });
    const db = scriptedDb(completeRules({ payload, qrTaken: true }));
    await expect(
      new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN)
    ).rejects.toMatchObject({ code: 'QR_CODE_IN_USE' });
  });

  it('refuses an owner email that already has an account', async () => {
    const db = scriptedDb(completeRules({ emailTaken: true }));
    await expect(
      new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN)
    ).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
  });

  it('an unregistered Model 1 partner is created, with a one-time password returned and nothing else exposing it', async () => {
    const db = scriptedDb(completeRules());
    const result = await new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN, {
      ipAddress: '10.0.0.1',
    });

    expect(result.organizationId).toBe(ORG);
    expect(result.owner.temporaryPassword).toMatch(
      /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/
    );
    const password = result.owner.temporaryPassword;

    // The owner is created as an owner who must change the password at first sign-in.
    const owner = db.sqlFor('INSERT INTO admin_users')[0];
    expect(owner.sql).toContain("'owner'");
    expect(owner.sql).toContain('must_change_password');
    expect(owner.params).not.toContain(password);

    // The password never reaches the draft, the organisation or the audit row.
    for (const call of db.calls) {
      expect(JSON.stringify(call.params ?? [])).not.toContain(password);
    }
    const audit = db.sqlFor('INSERT INTO audit_logs')[0];
    expect(String(audit.params[0])).toBe(ADMIN);
    expect(audit.params.join('|')).toContain('partner.onboarded');
    // The record says a GST flag was set, but never holds the number, the PAN or the password.
    expect(audit.params.join('|')).not.toContain(GST);
    expect(audit.params.join('|')).not.toContain('AAPFU0939F');
    expect(audit.params.join('|')).not.toContain(password);
    expect(db.sqlFor('COMMIT')).toHaveLength(1);
  });

  it('a revenue-share partner gets its split recorded in the same completion', async () => {
    const payload = completePayload({
      model: { businessModel: 'revenue-share' },
      terms: { partnerSharePct: 35, startsOn: null, note: 'Agreed on the call' },
    });
    const db = scriptedDb(completeRules({ payload }));
    await new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN);
    const split = db.sqlFor('INSERT INTO revenue_split_terms')[0];
    expect(split.params).toEqual(expect.arrayContaining([ORG, 35, 'Agreed on the call', ADMIN]));
  });

  it('if the owner cannot be created, the whole partner is rolled back: no commit, and the draft stays open', async () => {
    const base = scriptedDb(completeRules());
    const failing = {
      query: base.query,
      getClient: async () => ({
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          if (String(sql).includes('INSERT INTO admin_users'))
            throw new Error('owner insert failed');
          return base.client.query(sql, params);
        }),
        release: jest.fn(),
      }),
    };
    const svc = new OnboardingService(failing as never, fakeStore());
    await expect(svc.complete(DRAFT, ADMIN)).rejects.toThrow('owner insert failed');
    expect(base.sqlFor('COMMIT')).toHaveLength(0);
    expect(base.sqlFor('UPDATE partner_onboarding_drafts')).toHaveLength(0);
  });

  it('a draft that already became a partner cannot be completed twice', async () => {
    const db = scriptedDb([
      ['FROM partner_onboarding_drafts', [draftRow({ status: 'completed', organization_id: ORG })]],
    ]);
    await expect(
      new OnboardingService(db as never, fakeStore()).complete(DRAFT, ADMIN)
    ).rejects.toMatchObject({ code: 'DRAFT_COMPLETED' });
  });
});

describe('expiry and partner documents', () => {
  it('expires abandoned drafts and removes their staged files', async () => {
    const store = fakeStore();
    const db = scriptedDb([
      ['UPDATE partner_onboarding_drafts', [{ id: DRAFT }]],
      [
        'DELETE FROM partner_documents',
        [
          { id: DOC, storage_key: 'onboarding/a.pdf' },
          { id: 'd2', storage_key: 'onboarding/b.png' },
        ],
      ],
    ]);
    const out = await new OnboardingService(db as never, store).expireDrafts(new Date());
    expect(out).toEqual({ expired: 1, filesRemoved: 2 });
    expect(db.sqlFor('UPDATE partner_onboarding_drafts')[0].sql).toContain("status = 'expired'");
    expect(db.sqlFor('DELETE FROM partner_documents')[0].sql).toContain('organization_id IS NULL');
  });

  it('a partner document that is not this partner’s is a 404', async () => {
    const db = scriptedDb([]);
    await expect(
      new OnboardingService(db as never, fakeStore()).readPartnerDocument(ORG, DOC)
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reads a partner document back for download', async () => {
    const store = fakeStore();
    const db = scriptedDb([
      [
        'FROM partner_documents',
        [{ original_filename: 'gst.pdf', content_type: 'application/pdf', storage_key: 'k.pdf' }],
      ],
    ]);
    const out = await new OnboardingService(db as never, store).readPartnerDocument(ORG, DOC);
    expect(out.contentType).toBe('application/pdf');
    expect(store.downloadFile).toHaveBeenCalledWith('k.pdf');
  });
});
