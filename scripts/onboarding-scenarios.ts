/* eslint-disable no-console */
/**
 * Partner onboarding, end to end, against the local database and the local
 * object store. Every run creates fresh partners, so it can be repeated.
 *
 *   npx ts-node --transpile-only scripts/onboarding-scenarios.ts
 *
 * Refuses to run against a database that is not on this machine.
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { db } from '../src/config/database';
import env from '../src/config/environment';
import { AppError } from '../src/middleware/errorHandler';
import { onboardingService, DraftView } from '../src/services/onboardingService';
import { runOnboardingSweep } from '../src/jobs/onboardingJob';
import { storageService } from '../src/services/storageService';
import { DraftPayload, gstCheckCharacter } from '../src/services/onboardingRules';

const url = env.database.url ?? '';
if (!(/@(localhost|127\.0\.0\.1|\[::1\]|::1)[:/]/.test(url) || url === '')) {
  console.error('Refusing to run: the database is not on this machine.');
  process.exit(2);
}

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

/** A GSTIN that passes the check character, unique per run so runs never collide. */
function makeGstin(stateCode: string): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const pick = (n: number) =>
    Array.from({ length: n }, () => letters[crypto.randomInt(26)]).join('');
  const digits = (n: number) =>
    Array.from({ length: n }, () => String(crypto.randomInt(10))).join('');
  const pan = `${pick(5)}${digits(4)}${pick(1)}`;
  const first14 = `${stateCode}${pan}1Z`;
  return `${first14}${gstCheckCharacter(first14)}`;
}
const GST_MH = makeGstin('27');
const GST_DL = makeGstin('07');
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%test\n'), crypto.randomBytes(256)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  crypto.randomBytes(128),
]);

const tag = () => crypto.randomBytes(3).toString('hex');
const rows = async (sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows as Array<Record<string, unknown>>;

async function admin(): Promise<string> {
  const r = await rows(
    `SELECT id FROM admin_users WHERE email = 'qa-super@mprnt.test' AND is_active`
  );
  if (r.length === 0) throw new Error('qa-super@mprnt.test is needed to act as the platform');
  return r[0].id as string;
}

/** A complete wizard answer set for an unregistered Model 1 partner. */
function answers(t: string, over: Partial<DraftPayload> = {}): DraftPayload {
  return {
    business: {
      legalName: `Onboard ${t} Pvt Ltd`,
      tradingName: `Onboard ${t}`,
      businessType: 'stationery',
      addressLine1: '1 Test Road',
      city: 'Indore',
      state: 'Madhya Pradesh',
      pincode: '452001',
      contactName: 'Test Contact',
      contactPhone: '9876543210',
      billingEmail: `billing-${t}@onboard.test`,
      gstRegistered: false,
    },
    model: { businessModel: 'integration' },
    qrPoint: null,
    owner: { fullName: 'Test Owner', email: `owner-${t}@onboard.test` },
    ...over,
  };
}

async function draftWith(actor: string, payload: DraftPayload): Promise<DraftView> {
  const draft = await onboardingService.createDraft(actor);
  return onboardingService.patchDraft(draft.id, draft.version, payload);
}

async function expectCode(name: string, fn: () => Promise<unknown>, code: string) {
  try {
    await fn();
    check(name, false, 'accepted, but should have been refused');
  } catch (error) {
    const got = error instanceof AppError ? error.code : String(error);
    check(name, got === code, `refused with ${got}`);
  }
}

async function main() {
  const ADMIN = await admin();

  // O1. An unregistered Model 1 partner, with a first QR point.
  {
    const t = tag();
    const qr = `OB${t.slice(0, 4).toUpperCase()}`;
    const draft = await draftWith(
      ADMIN,
      answers(t, {
        qrPoint: {
          code: qr,
          name: 'Front counter',
          location: 'Ground floor',
          paperSizes: ['a4', 'a5'],
        },
      })
    );
    check(
      'O1a a draft with every answer has no problems left',
      draft.problems.length === 0,
      JSON.stringify(draft.problems)
    );
    const done = await onboardingService.complete(draft.id, ADMIN, { ipAddress: '127.0.0.1' });
    const org = await rows(
      `SELECT name, status, business_model, gst_registered, gst_number, state FROM organizations WHERE id = $1`,
      [done.organizationId]
    );
    check(
      'O1b the partner is created, active, on Model 1, not GST-registered',
      org[0]?.status === 'active' &&
        org[0]?.business_model === 'integration' &&
        org[0]?.gst_registered === false &&
        org[0]?.gst_number === null
    );
    const kiosk = await rows(
      `SELECT kiosk_id, organization_id, capabilities FROM kiosks WHERE kiosk_id = $1`,
      [qr]
    );
    check(
      'O1c the QR point is created under that partner, with its paper sizes',
      kiosk[0]?.organization_id === done.organizationId &&
        JSON.stringify(kiosk[0]?.capabilities).includes('a5')
    );
    const owner = await rows(
      `SELECT role, must_change_password, organization_id, password_hash FROM admin_users WHERE id = $1`,
      [done.owner.id]
    );
    check(
      'O1d the owner is an owner of that partner, and must change the password',
      owner[0]?.role === 'owner' &&
        owner[0]?.must_change_password === true &&
        owner[0]?.organization_id === done.organizationId
    );
    check(
      'O1e the temporary password works, and only as a bcrypt hash is stored',
      (await bcrypt.compare(done.owner.temporaryPassword, String(owner[0]?.password_hash))) &&
        !String(owner[0]?.password_hash).includes(done.owner.temporaryPassword)
    );
    const leaked = await rows(
      `SELECT 1 FROM partner_onboarding_drafts WHERE id = $1 AND payload::text LIKE '%' || $2 || '%'`,
      [draft.id, done.owner.temporaryPassword]
    );
    const audit = await rows(
      `SELECT details::text AS d FROM audit_logs WHERE resource_id = $1 AND action = 'partner.onboarded'`,
      [done.organizationId]
    );
    check(
      'O1f the password is not in the draft, and not in the audit trail',
      leaked.length === 0 &&
        audit.length === 1 &&
        !String(audit[0].d).includes(done.owner.temporaryPassword)
    );
    const draftNow = await rows(`SELECT status FROM partner_onboarding_drafts WHERE id = $1`, [
      draft.id,
    ]);
    check('O1g the draft becomes a completed record', draftNow[0]?.status === 'completed');
    await expectCode(
      'O1h completing the same draft again is refused',
      () => onboardingService.complete(draft.id, ADMIN),
      'DRAFT_COMPLETED'
    );
  }

  // O2. A GST-registered Model 2A partner: certificate uploaded, split recorded.
  let gstOrg = '';
  {
    const t = tag();
    const gst = GST_MH;
    const draft = await draftWith(
      ADMIN,
      answers(t, {
        business: {
          ...answers(t).business,
          gstRegistered: true,
          gstNumber: gst,
          state: 'Maharashtra',
          pan: gst.slice(2, 12),
        },
        model: { businessModel: 'revenue-share' },
        terms: { partnerSharePct: 35, startsOn: null, note: 'Agreed on the call' },
      })
    );
    const missingCert = draft.problems.map((p) => p.field);
    check(
      'O2a a GST partner without its certificate is told to upload it',
      missingCert.includes('documents.gst_certificate'),
      JSON.stringify(missingCert)
    );
    await onboardingService.addDocument(draft.id, {
      kind: 'gst_certificate',
      original: 'GST cert.pdf',
      claimedType: 'application/pdf',
      bytes: PDF,
      actorId: ADMIN,
    });
    const withDoc = await onboardingService.getDraft(draft.id);
    check(
      'O2b with the certificate attached, the draft is ready',
      withDoc.problems.length === 0,
      JSON.stringify(withDoc.problems)
    );
    const done = await onboardingService.complete(draft.id, ADMIN);
    gstOrg = done.organizationId;
    const split = await rows(
      `SELECT partner_share_pct::float8 AS pct, note FROM revenue_split_terms WHERE organization_id = $1`,
      [gstOrg]
    );
    check(
      'O2c the 2A split is recorded at 35% with the note',
      split.length === 1 && Number(split[0].pct) === 35 && split[0].note === 'Agreed on the call'
    );
    const docs = await rows(
      `SELECT kind, organization_id, sha256 FROM partner_documents WHERE organization_id = $1`,
      [gstOrg]
    );
    check(
      'O2d the certificate now belongs to the partner',
      docs.length === 1 && docs[0].kind === 'gst_certificate'
    );
    const bytes = await onboardingService.readPartnerDocument(
      gstOrg,
      String(
        (await rows(`SELECT id FROM partner_documents WHERE organization_id = $1`, [gstOrg]))[0].id
      )
    );
    const hash = crypto.createHash('sha256').update(bytes.bytes).digest('hex');
    check(
      'O2e the certificate reads back byte-for-byte, matching its recorded hash',
      hash === docs[0].sha256
    );
    let refused = '';
    try {
      await rows(
        `UPDATE partner_documents SET original_filename = 'x' WHERE organization_id = $1`,
        [gstOrg]
      );
    } catch (error) {
      refused = (error as { code?: string }).code ?? '';
    }
    check(
      'O2f a held document cannot be changed in the database',
      refused === '23001',
      `refused with ${refused || 'nothing'}`
    );
  }

  // O3. GST refusals.
  {
    const t = tag();
    const base = answers(t).business!;
    const d1 = await draftWith(
      ADMIN,
      answers(t, {
        business: {
          ...base,
          gstRegistered: true,
          state: 'Maharashtra',
          gstNumber: GST_MH.slice(0, 14) + (GST_MH[14] === 'V' ? 'W' : 'V'),
        },
      })
    );
    check(
      'O3a a GSTIN with a wrong check character is flagged',
      d1.problems.some(
        (p) => p.field === 'business.gstNumber' && /does not check out/.test(p.message)
      )
    );
    const d2 = await draftWith(
      ADMIN,
      answers(t, { business: { ...base, gstRegistered: true, state: 'Delhi', gstNumber: GST_MH } })
    );
    check(
      'O3b a GSTIN from another state is flagged, naming the right state code',
      d2.problems.some((p) => p.field === 'business.gstNumber' && /another state/.test(p.message))
    );
    const d3 = await draftWith(
      ADMIN,
      answers(t, { business: { ...base, gstRegistered: false, gstNumber: GST_DL } })
    );
    check(
      'O3c a GSTIN on an unregistered business is refused, not ignored',
      d3.problems.some((p) => p.field === 'business.gstNumber')
    );
  }

  // O4. The same GSTIN cannot make two partners.
  {
    const t = tag();
    const base = answers(t).business!;
    const draft = await draftWith(
      ADMIN,
      answers(t, {
        business: { ...base, gstRegistered: true, state: 'Maharashtra', gstNumber: GST_MH },
      })
    );
    await onboardingService.addDocument(draft.id, {
      kind: 'gst_certificate',
      original: 'c.pdf',
      claimedType: 'application/pdf',
      bytes: PDF,
      actorId: ADMIN,
    });
    const before = Number((await rows(`SELECT COUNT(*)::int AS n FROM organizations`))[0].n);
    await expectCode(
      'O4a a second partner with the same GSTIN is refused',
      () => onboardingService.complete(draft.id, ADMIN),
      'GST_IN_USE'
    );
    const after = Number((await rows(`SELECT COUNT(*)::int AS n FROM organizations`))[0].n);
    check('O4b the refusal created no partner at all', before === after);
  }

  // O5. A taken QR code rolls back the whole onboarding.
  {
    const t = tag();
    const takenCode = (await rows(`SELECT kiosk_id FROM kiosks LIMIT 1`))[0].kiosk_id as string;
    const draft = await draftWith(
      ADMIN,
      answers(t, { qrPoint: { code: takenCode, name: 'Clash', location: 'Here' } })
    );
    check(
      'O5a the wizard warns about a taken QR code before completion',
      draft.conflicts.some((c) => c.field === 'qrPoint.code')
    );
    const before = Number((await rows(`SELECT COUNT(*)::int AS n FROM organizations`))[0].n);
    await expectCode(
      'O5b completing with a taken QR code is refused',
      () => onboardingService.complete(draft.id, ADMIN),
      'QR_CODE_IN_USE'
    );
    const after = Number((await rows(`SELECT COUNT(*)::int AS n FROM organizations`))[0].n);
    const stillOpen = await rows(`SELECT status FROM partner_onboarding_drafts WHERE id = $1`, [
      draft.id,
    ]);
    check(
      'O5c nothing was created, and the draft is still open to fix',
      before === after && stillOpen[0]?.status === 'open'
    );
  }

  // O6. An owner email that already has an account.
  {
    const t = tag();
    const existing = (
      await rows(`SELECT email FROM admin_users WHERE deleted_at IS NULL AND is_active LIMIT 1`)
    )[0].email as string;
    const draft = await draftWith(
      ADMIN,
      answers(t, { owner: { fullName: 'Dup', email: existing } })
    );
    await expectCode(
      'O6 an owner email already in use is refused',
      () => onboardingService.complete(draft.id, ADMIN),
      'EMAIL_IN_USE'
    );
  }

  // O7. Two people saving the same draft: the second one is told.
  {
    const t = tag();
    const draft = await onboardingService.createDraft(ADMIN);
    await onboardingService.patchDraft(draft.id, draft.version, {
      business: { city: 'Indore' },
    });
    await expectCode(
      'O7 a save against an old version is refused, not overwritten',
      () =>
        onboardingService.patchDraft(draft.id, draft.version, {
          business: { city: 'Pune' },
        }),
      'VERSION_CONFLICT'
    );
    void t;
  }

  // O8. Two completions at once: exactly one partner.
  {
    const t = tag();
    const draft = await draftWith(ADMIN, answers(t));
    const outcomes = await Promise.allSettled([
      onboardingService.complete(draft.id, ADMIN),
      onboardingService.complete(draft.id, ADMIN),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled').length;
    const made = Number(
      (
        await rows(`SELECT COUNT(*)::int AS n FROM organizations WHERE contact_email = $1`, [
          `billing-${t}@onboard.test`,
        ])
      )[0].n
    );
    check(
      'O8 two completions at once make exactly one partner',
      won === 1 && made === 1,
      `won ${won}, partners ${made}`
    );
  }

  // O9. A model that is not available yet cannot be completed.
  {
    const t = tag();
    const draft = await draftWith(ADMIN, answers(t, { model: { businessModel: 'own-station' } }));
    check(
      'O9a 2B is shown as not available',
      draft.problems.some((p) => p.field === 'model.businessModel')
    );
    await expectCode(
      'O9b completing a 2B partner is refused',
      () => onboardingService.complete(draft.id, ADMIN),
      'DRAFT_INCOMPLETE'
    );
  }

  // O10. A file that only claims to be a PDF.
  {
    const draft = await onboardingService.createDraft(ADMIN);
    await expectCode(
      'O10a a text file renamed to .pdf is refused',
      () =>
        onboardingService.addDocument(draft.id, {
          kind: 'gst_certificate',
          original: 'x.pdf',
          claimedType: 'application/pdf',
          bytes: Buffer.from('just text'),
          actorId: ADMIN,
        }),
      'DOCUMENT_TYPE_REFUSED'
    );
    await expectCode(
      'O10b a PNG claimed as a PDF is refused',
      () =>
        onboardingService.addDocument(draft.id, {
          kind: 'gst_certificate',
          original: 'x.pdf',
          claimedType: 'application/pdf',
          bytes: PNG,
          actorId: ADMIN,
        }),
      'DOCUMENT_TYPE_MISMATCH'
    );
  }

  // O11. A second GST certificate replaces the first, and the first file is removed.
  {
    const draft = await onboardingService.createDraft(ADMIN);
    const first = await onboardingService.addDocument(draft.id, {
      kind: 'gst_certificate',
      original: 'a.pdf',
      claimedType: 'application/pdf',
      bytes: PDF,
      actorId: ADMIN,
    });
    const second = await onboardingService.addDocument(draft.id, {
      kind: 'gst_certificate',
      original: 'b.png',
      claimedType: 'image/png',
      bytes: PNG,
      actorId: ADMIN,
    });
    const staged = await rows(
      `SELECT id FROM partner_documents WHERE draft_id = $1 AND organization_id IS NULL`,
      [draft.id]
    );
    check(
      'O11a one GST certificate is held at a time',
      staged.length === 1 && staged[0].id === second.id
    );
    let firstGone = false;
    try {
      await storageService.downloadFile(`onboarding/${draft.id}/${first.id}.pdf`);
    } catch {
      firstGone = true;
    }
    check('O11b the replaced file is removed from storage', firstGone);
  }

  // O12. A draft that is left alone expires, and its files go with it.
  {
    const draft = await onboardingService.createDraft(ADMIN);
    const doc = await onboardingService.addDocument(draft.id, {
      kind: 'other',
      original: 'o.pdf',
      claimedType: 'application/pdf',
      bytes: PDF,
      actorId: ADMIN,
    });
    await rows(
      `UPDATE partner_onboarding_drafts SET expires_at = NOW() - interval '1 hour' WHERE id = $1`,
      [draft.id]
    );
    await expectCode(
      'O12a an expired draft cannot be saved',
      () =>
        onboardingService.patchDraft(draft.id, draft.version, {
          business: { city: 'Late' },
        }),
      'DRAFT_EXPIRED'
    );
    const sweep = await runOnboardingSweep();
    const expiredStatus = await rows(`SELECT status FROM partner_onboarding_drafts WHERE id = $1`, [
      draft.id,
    ]);
    check('O12b the sweep marks it expired', expiredStatus[0]?.status === 'expired');
    check(
      'O12c the sweep removes the staged file',
      (sweep?.filesRemoved ?? 0) >= 1 &&
        (await rows(`SELECT 1 FROM partner_documents WHERE id = $1`, [doc.id])).length === 0
    );
  }

  // O13. Removing a staged document.
  {
    const draft = await onboardingService.createDraft(ADMIN);
    const doc = await onboardingService.addDocument(draft.id, {
      kind: 'other',
      original: 'r.pdf',
      claimedType: 'application/pdf',
      bytes: PDF,
      actorId: ADMIN,
    });
    await onboardingService.removeDocument(draft.id, doc.id);
    check(
      'O13 a staged document can be removed',
      (await rows(`SELECT 1 FROM partner_documents WHERE id = $1`, [doc.id])).length === 0
    );
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `   [${r.detail}]`}`);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error('Onboarding run crashed:', error);
  process.exit(2);
});
