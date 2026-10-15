import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Database, PoolClient, db } from '../config/database';
import env from '../config/environment';
import { AppError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { generateTemporaryPassword } from '../utils/temporaryPassword';
import { auditService } from './auditService';
import { storageService } from './storageService';
import {
  checkGstin,
  completionProblems,
  DOCUMENT_CONTENT_TYPE,
  DraftPayload,
  DraftProblem,
  MAX_DOCUMENT_BYTES,
  sniffDocument,
} from './onboardingRules';

/**
 * Partner onboarding. A draft is saved as the super admin works; completing it
 * creates the partner, its terms, its first QR point, its owner login and its
 * documents in one transaction, or none of them.
 */

export const DRAFT_LIFETIME_DAYS = 7;
const DOCUMENT_KINDS = ['gst_certificate', 'agreement', 'other'] as const;
export type StagedKind = (typeof DOCUMENT_KINDS)[number];

/** The subset of the storage service this module needs, so tests can supply a fake. */
export interface DocumentStore {
  uploadFile(key: string, body: Buffer, contentType: string): Promise<string>;
  downloadFile(key: string): Promise<Buffer>;
  deleteFile(key: string): Promise<void>;
}

type Queryable = Pick<PoolClient, 'query'>;

/** Where a change came from, recorded in the audit row. Never used for any decision. */
export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface DraftView {
  id: string;
  status: 'open' | 'completed' | 'expired';
  version: number;
  expiresAt: string;
  payload: DraftPayload;
  documents: Array<{
    id: string;
    kind: string;
    originalFilename: string;
    sizeBytes: number;
    uploadedAt: string;
  }>;
  /** What is still missing or wrong. Empty means the draft can be completed. */
  problems: DraftProblem[];
  /** Things already in use, shown as warnings while the draft is being filled in. */
  conflicts: DraftProblem[];
}

interface DraftRow {
  id: string;
  status: string;
  payload: DraftPayload;
  version: number;
  expires_at: Date;
  organization_id: string | null;
  expired: boolean;
}

export class OnboardingService {
  constructor(
    private database: Database = db,
    private store: DocumentStore = storageService
  ) {}

  /** Borrows a pooled connection for one read, so reads and writes share one query type. */
  private async withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.database.getClient();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.getClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------

  async createDraft(actorId: string): Promise<DraftView> {
    const result = await this.database.query<{ id: string }>(
      `INSERT INTO partner_onboarding_drafts (created_by, expires_at)
       VALUES ($1, NOW() + ($2 || ' days')::interval)
       RETURNING id`,
      [actorId, String(DRAFT_LIFETIME_DAYS)]
    );
    return this.getDraft(result.rows[0].id);
  }

  async getDraft(id: string): Promise<DraftView> {
    return this.withClient((client) => this.readDraft(client, id));
  }

  private async readDraft(client: Queryable, id: string): Promise<DraftView> {
    const row = await this.loadDraft(client, id);
    if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');

    const docs = await client.query<{
      id: string;
      kind: string;
      original_filename: string;
      size_bytes: number;
      uploaded_at: Date;
    }>(
      `SELECT id, kind, original_filename, size_bytes, uploaded_at
         FROM partner_documents
        WHERE draft_id = $1 AND organization_id IS NULL
        ORDER BY uploaded_at`,
      [id]
    );
    const kinds = docs.rows.map((d) => d.kind);
    const problems = completionProblems(row.payload, kinds);
    const conflicts = await this.conflictsFor(client, row.payload);

    return {
      id: row.id,
      status: this.effectiveStatus(row),
      version: row.version,
      expiresAt: row.expires_at.toISOString(),
      payload: row.payload,
      documents: docs.rows.map((d) => ({
        id: d.id,
        kind: d.kind,
        originalFilename: d.original_filename,
        sizeBytes: d.size_bytes,
        uploadedAt: d.uploaded_at.toISOString(),
      })),
      problems,
      conflicts,
    };
  }

  /**
   * Saves part of the draft. The caller names the version it read; if someone
   * else saved in between, the save is refused instead of overwriting them.
   */
  async patchDraft(id: string, expectedVersion: number, patch: DraftPayload): Promise<DraftView> {
    await this.tx(async (client) => {
      const row = await this.loadDraft(client, id, true);
      if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');
      this.assertOpen(row);
      if (row.version !== expectedVersion) {
        throw new AppError(
          'This draft was changed by someone else. Reload it before saving.',
          409,
          'VERSION_CONFLICT'
        );
      }

      const merged: DraftPayload = { ...row.payload };
      for (const section of ['business', 'model', 'terms', 'owner'] as const) {
        if (patch[section] !== undefined) {
          merged[section] = { ...(row.payload[section] ?? {}), ...patch[section] };
        }
      }
      if (patch.qrPoint !== undefined) {
        merged.qrPoint =
          patch.qrPoint === null ? null : { ...(row.payload.qrPoint ?? {}), ...patch.qrPoint };
      }

      await client.query(
        `UPDATE partner_onboarding_drafts
            SET payload = $2, version = version + 1, updated_at = NOW()
          WHERE id = $1`,
        [id, JSON.stringify(merged)]
      );
    });
    return this.getDraft(id);
  }

  /** Staged documents of a draft, or none, for a draft that will be abandoned. */
  async expireDrafts(now: Date = new Date()): Promise<{ expired: number; filesRemoved: number }> {
    const due = await this.database.query<{ id: string }>(
      `UPDATE partner_onboarding_drafts
          SET status = 'expired', updated_at = NOW()
        WHERE status = 'open' AND expires_at < $1
        RETURNING id`,
      [now]
    );
    let filesRemoved = 0;
    for (const { id } of due.rows) {
      const staged = await this.database.query<{ id: string; storage_key: string }>(
        `DELETE FROM partner_documents
          WHERE draft_id = $1 AND organization_id IS NULL
          RETURNING id, storage_key`,
        [id]
      );
      for (const doc of staged.rows) {
        if (await this.removeObject(doc.storage_key)) filesRemoved++;
      }
    }
    if (due.rows.length > 0) {
      logger.info('Onboarding drafts expired', { drafts: due.rows.length, filesRemoved });
    }
    return { expired: due.rows.length, filesRemoved };
  }

  // -------------------------------------------------------------------------
  // Documents
  // -------------------------------------------------------------------------

  /**
   * Stages a document against a draft. The file is checked by its bytes, not by
   * the type the browser claims. A second GST certificate replaces the first.
   */
  async addDocument(
    draftId: string,
    input: { kind: string; original: string; claimedType: string; bytes: Buffer; actorId: string }
  ): Promise<DraftView['documents'][number]> {
    if (!(DOCUMENT_KINDS as readonly string[]).includes(input.kind)) {
      throw new AppError('Choose what the document is', 400, 'BAD_DOCUMENT_KIND');
    }
    if (input.bytes.length === 0) {
      throw new AppError('The file is empty', 400, 'EMPTY_DOCUMENT');
    }
    if (input.bytes.length > MAX_DOCUMENT_BYTES) {
      throw new AppError('A document can be at most 5 MB', 413, 'DOCUMENT_TOO_LARGE');
    }
    const sniffed = sniffDocument(input.bytes);
    if (!sniffed) {
      throw new AppError('Only PDF, PNG or JPEG files are accepted', 400, 'DOCUMENT_TYPE_REFUSED');
    }
    if (input.claimedType !== DOCUMENT_CONTENT_TYPE[sniffed]) {
      throw new AppError('The file is not what its type says it is', 400, 'DOCUMENT_TYPE_MISMATCH');
    }

    const docId = crypto.randomUUID();
    const extension = sniffed === 'jpeg' ? 'jpg' : sniffed;
    const storageKey = `onboarding/${draftId}/${docId}.${extension}`;
    const sha256 = crypto.createHash('sha256').update(input.bytes).digest('hex');

    await this.tx(async (client) => {
      const row = await this.loadDraft(client, draftId, true);
      if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');
      this.assertOpen(row);
    });

    await this.store.uploadFile(storageKey, input.bytes, DOCUMENT_CONTENT_TYPE[sniffed]);

    try {
      const replaced = await this.tx(async (client) => {
        const row = await this.loadDraft(client, draftId, true);
        if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');
        this.assertOpen(row);

        // One GST certificate per draft: a new upload replaces the old one.
        const old =
          input.kind === 'gst_certificate'
            ? await client.query<{ storage_key: string }>(
                `DELETE FROM partner_documents
                WHERE draft_id = $1 AND kind = 'gst_certificate' AND organization_id IS NULL
                RETURNING storage_key`,
                [draftId]
              )
            : { rows: [] as Array<{ storage_key: string }> };

        const inserted = await client.query<{ id: string; uploaded_at: Date }>(
          `INSERT INTO partner_documents (
             id, draft_id, kind, storage_key, original_filename, content_type,
             size_bytes, sha256, uploaded_by
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, uploaded_at`,
          [
            docId,
            draftId,
            input.kind,
            storageKey,
            input.original.slice(0, 255),
            DOCUMENT_CONTENT_TYPE[sniffed],
            input.bytes.length,
            sha256,
            input.actorId,
          ]
        );
        return { old: old.rows.map((r) => r.storage_key), uploaded: inserted.rows[0] };
      });

      for (const key of replaced.old) await this.removeObject(key);
      return {
        id: docId,
        kind: input.kind,
        originalFilename: input.original.slice(0, 255),
        sizeBytes: input.bytes.length,
        uploadedAt: replaced.uploaded.uploaded_at.toISOString(),
      };
    } catch (error) {
      // The row never landed, so the file would be an orphan. Remove it.
      await this.removeObject(storageKey);
      throw error;
    }
  }

  async removeDocument(draftId: string, docId: string): Promise<void> {
    const key = await this.tx(async (client) => {
      const row = await this.loadDraft(client, draftId, true);
      if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');
      this.assertOpen(row);
      const removed = await client.query<{ storage_key: string }>(
        `DELETE FROM partner_documents
          WHERE id = $1 AND draft_id = $2 AND organization_id IS NULL
          RETURNING storage_key`,
        [docId, draftId]
      );
      if (removed.rows.length === 0)
        throw new AppError('Document not found on this draft', 404, 'DOCUMENT_NOT_FOUND');
      return removed.rows[0].storage_key;
    });
    await this.removeObject(key);
  }

  // -------------------------------------------------------------------------
  // Completion
  // -------------------------------------------------------------------------

  /**
   * Creates the partner. Everything happens in one transaction; any failure
   * rolls back the lot, including the owner's login and the documents' link.
   * The temporary password is returned here and nowhere else.
   */
  async complete(draftId: string, actorId: string, request: RequestMeta = {}) {
    const bcryptRounds = env.security.bcrypt_rounds;

    return this.tx(async (client) => {
      const row = await this.loadDraft(client, draftId, true);
      if (!row) throw new AppError('Draft not found', 404, 'DRAFT_NOT_FOUND');
      this.assertOpen(row);

      const docs = await client.query<{ id: string; kind: string; storage_key: string }>(
        `SELECT id, kind, storage_key FROM partner_documents
          WHERE draft_id = $1 AND organization_id IS NULL`,
        [draftId]
      );
      const problems = completionProblems(
        row.payload,
        docs.rows.map((d) => d.kind)
      );
      if (problems.length > 0) {
        throw new AppError('The draft is not complete yet', 400, 'DRAFT_INCOMPLETE', problems);
      }

      const p = row.payload;
      const b = p.business!;
      const gst = b.gstRegistered ? b.gstNumber!.toUpperCase() : null;
      const pan = b.gstRegistered && gst ? (checkGstin(gst).pan ?? b.pan ?? null) : (b.pan ?? null);
      const ownerEmail = p.owner!.email!.trim().toLowerCase();
      const qrCode = p.qrPoint ? p.qrPoint.code!.toUpperCase() : null;

      const conflicts = await this.conflictsFor(client, p);
      if (conflicts.length > 0) {
        const first = conflicts[0];
        const code =
          first.field === 'business.gstNumber'
            ? 'GST_IN_USE'
            : first.field === 'qrPoint.code'
              ? 'QR_CODE_IN_USE'
              : 'EMAIL_IN_USE';
        throw new AppError(first.message, 409, code, conflicts);
      }

      const slug = await this.uniqueSlug(client, b.tradingName!);
      const orgResult = await client.query<{ id: string }>(
        `INSERT INTO organizations (
           name, slug, status, timezone, business_model,
           contact_email, contact_phone, contact_name, notes,
           legal_name, trading_name, business_type,
           address_line1, address_line2, city, state, pincode,
           gst_registered, gst_number, pan, onboarded_at, onboarded_by
         ) VALUES (
           $1, $2, 'active', 'Asia/Kolkata', $3,
           $4, $5, $6, $7,
           $8, $9, $10,
           $11, $12, $13, $14, $15,
           $16, $17, $18, NOW(), $19
         ) RETURNING id`,
        [
          b.tradingName!.trim(),
          slug,
          p.model!.businessModel,
          b.billingEmail!.trim().toLowerCase(),
          b.contactPhone!.replace(/\s+/g, ''),
          b.contactName!.trim(),
          b.notes ?? null,
          b.legalName!.trim(),
          b.tradingName!.trim(),
          b.businessType,
          b.addressLine1!.trim(),
          b.addressLine2 ?? null,
          b.city!.trim(),
          b.state,
          b.pincode,
          b.gstRegistered,
          gst,
          pan,
          actorId,
        ]
      );
      const organizationId = orgResult.rows[0].id;

      if (p.model!.businessModel === 'revenue-share') {
        await client.query(
          `INSERT INTO revenue_split_terms (
             organization_id, kiosk_id, partner_share_pct, effective_from, note, created_by
           ) VALUES (
             $1, NULL, $2,
             COALESCE(($3::date)::timestamp AT TIME ZONE 'Asia/Kolkata', NOW()),
             $4, $5
           )`,
          [
            organizationId,
            p.terms!.partnerSharePct,
            p.terms!.startsOn ?? null,
            p.terms!.note!.trim(),
            actorId,
          ]
        );
      }

      let qrPointId: string | null = null;
      if (p.qrPoint) {
        const q = p.qrPoint;
        const kiosk = await client.query<{ id: string }>(
          `INSERT INTO kiosks (kiosk_id, name, location, organization_id, status, capabilities, created_at, updated_at)
           VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW())
           RETURNING id`,
          [
            qrCode,
            q.name!.trim(),
            q.location!.trim(),
            organizationId,
            JSON.stringify({
              color: false,
              duplex: false,
              paper_sizes: q.paperSizes?.length ? q.paperSizes : ['a4'],
            }),
          ]
        );
        qrPointId = kiosk.rows[0].id;
      }

      const temporaryPassword = generateTemporaryPassword();
      const hash = await bcrypt.hash(temporaryPassword, bcryptRounds);
      const owner = await client.query<{ id: string }>(
        `INSERT INTO admin_users (
           email, password_hash, full_name, role, organization_id,
           is_active, must_change_password, created_by, created_at, updated_at
         ) VALUES ($1, $2, $3, 'owner', $4, true, true, $5, NOW(), NOW())
         RETURNING id`,
        [ownerEmail, hash, p.owner!.fullName!.trim(), organizationId, actorId]
      );

      await client.query(
        `UPDATE partner_documents SET organization_id = $2
          WHERE draft_id = $1 AND organization_id IS NULL`,
        [draftId, organizationId]
      );

      await client.query(
        `UPDATE partner_onboarding_drafts
            SET status = 'completed', organization_id = $2, completed_at = NOW(),
                completed_by = $3, updated_at = NOW()
          WHERE id = $1`,
        [draftId, organizationId, actorId]
      );

      // The audit row says what was created. It never holds the password, the GST
      // number or the PAN: the record of who onboarded whom should not be a copy of them.
      await auditService.record(
        {
          actorId,
          actorScope: 'platform',
          action: 'partner.onboarded',
          resourceType: 'organization',
          resourceId: organizationId,
          organizationId,
          details: {
            businessType: b.businessType,
            businessModel: p.model!.businessModel,
            gstRegistered: b.gstRegistered,
            qrCode,
            ownerEmail,
            documents: docs.rows.map((d) => d.kind),
          },
          ...request,
        },
        client
      );

      return {
        organizationId,
        slug,
        owner: { id: owner.rows[0].id, email: ownerEmail, temporaryPassword },
        qrPoint: qrPointId && qrCode ? { id: qrPointId, code: qrCode } : null,
        documents: docs.rows.length,
        nextSteps: this.nextSteps(p.model!.businessModel!),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Documents held for a partner (read, and download by a super admin)
  // -------------------------------------------------------------------------

  async listPartnerDocuments(organizationId: string) {
    const result = await this.database.query<{
      id: string;
      kind: string;
      original_filename: string;
      content_type: string;
      size_bytes: number;
      sha256: string;
      uploaded_at: Date;
    }>(
      `SELECT id, kind, original_filename, content_type, size_bytes, sha256, uploaded_at
         FROM partner_documents
        WHERE organization_id = $1
        ORDER BY uploaded_at`,
      [organizationId]
    );
    return result.rows.map((d) => ({
      id: d.id,
      kind: d.kind,
      originalFilename: d.original_filename,
      contentType: d.content_type,
      sizeBytes: d.size_bytes,
      sha256: d.sha256,
      uploadedAt: d.uploaded_at.toISOString(),
    }));
  }

  async readPartnerDocument(organizationId: string, docId: string) {
    const result = await this.database.query<{
      original_filename: string;
      content_type: string;
      storage_key: string;
    }>(
      `SELECT original_filename, content_type, storage_key
         FROM partner_documents
        WHERE id = $1 AND organization_id = $2`,
      [docId, organizationId]
    );
    if (result.rows.length === 0)
      throw new AppError('Document not found', 404, 'DOCUMENT_NOT_FOUND');
    const row = result.rows[0];
    const bytes = await this.store.downloadFile(row.storage_key);
    return { bytes, contentType: row.content_type, filename: row.original_filename };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async loadDraft(client: Queryable, id: string, lock = false): Promise<DraftRow | null> {
    const result = await client.query<DraftRow & { expired: boolean }>(
      `SELECT id, status, payload, version, expires_at, organization_id,
              (expires_at < NOW()) AS expired
         FROM partner_onboarding_drafts
        WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  private assertOpen(row: DraftRow): void {
    if (row.status === 'completed') {
      throw new AppError('This draft has already become a partner', 409, 'DRAFT_COMPLETED');
    }
    if (row.status === 'expired' || row.expired) {
      throw new AppError('This draft has expired. Start a new one.', 410, 'DRAFT_EXPIRED');
    }
  }

  private effectiveStatus(row: DraftRow): DraftView['status'] {
    if (row.status === 'completed') return 'completed';
    if (row.status === 'expired' || row.expired) return 'expired';
    return 'open';
  }

  /** Things in the draft that are already taken, so the wizard can say so early. */
  private async conflictsFor(client: Queryable, p: DraftPayload): Promise<DraftProblem[]> {
    const out: DraftProblem[] = [];
    const gst = p.business?.gstRegistered ? p.business.gstNumber?.toUpperCase() : null;
    if (gst && checkGstin(gst).ok) {
      const r = await client.query(
        `SELECT 1 FROM organizations WHERE gst_number = $1 AND deleted_at IS NULL`,
        [gst]
      );
      if (r.rows.length > 0)
        out.push({
          field: 'business.gstNumber',
          message: 'Another partner is already registered with this GST number',
        });
    }
    if (p.qrPoint?.code && /^[A-Za-z0-9-]{2,10}$/.test(p.qrPoint.code)) {
      const r = await client.query(`SELECT 1 FROM kiosks WHERE kiosk_id = $1`, [
        p.qrPoint.code.toUpperCase(),
      ]);
      if (r.rows.length > 0)
        out.push({
          field: 'qrPoint.code',
          message: `QR code ${p.qrPoint.code.toUpperCase()} is already in use`,
        });
    }
    if (p.owner?.email) {
      const r = await client.query(
        `SELECT 1 FROM admin_users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
        [p.owner.email]
      );
      if (r.rows.length > 0)
        out.push({ field: 'owner.email', message: 'An account with this email already exists' });
    }
    return out;
  }

  private async uniqueSlug(client: Queryable, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 56) || 'partner';
    for (let n = 1; n < 1000; n++) {
      const candidate = n === 1 ? base : `${base}-${n}`;
      const taken = await client.query(`SELECT 1 FROM organizations WHERE slug = $1`, [candidate]);
      if (taken.rows.length === 0) return candidate;
    }
    throw new AppError('Could not find a free address for this partner name', 409, 'SLUG_TAKEN');
  }

  private nextSteps(model: string): string[] {
    if (model === 'integration') {
      return [
        'Record the hardware sale on the partner’s Billing tab, then take the payment or waive it',
        'Go live on the install date, which starts the free month',
      ];
    }
    return ['Share the revenue split with the owner once it is confirmed'];
  }

  /** Removes a stored file. A failure is logged, not thrown: the database row is already gone. */
  private async removeObject(key: string): Promise<boolean> {
    try {
      await this.store.deleteFile(key);
      return true;
    } catch (error) {
      logger.error('Could not remove a staged onboarding document', { key, error });
      return false;
    }
  }
}

export const onboardingService = new OnboardingService();
