import {
  RevenueSplitService,
  TermRecord,
  classifyTerms,
  effectiveTerm,
  platformSharePct,
} from '../../src/services/revenueSplitService';
import { AppError } from '../../src/middleware/errorHandler';
import { dashboardService } from '../../src/services/dashboardService';
import { scriptedDb, ScriptedDb, Rule } from '../helpers/fakeDb';

jest.mock('../../src/config/database');

const NOW = new Date('2026-10-12T06:00:00Z');
const ORG = '11111111-1111-4111-8111-111111111111';
const KIOSK = '22222222-2222-4222-8222-222222222222';
const KIOSK_OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';

const term = (over: Partial<TermRecord> & { id: string }): TermRecord => ({
  kioskId: null,
  partnerSharePct: 30,
  effectiveFrom: new Date('2026-09-01T00:00:00Z'),
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

describe('platformSharePct', () => {
  it('is always the rest of the sale, to two places', () => {
    expect(platformSharePct(30)).toBe(70);
    expect(platformSharePct(0)).toBe(100);
    expect(platformSharePct(100)).toBe(0);
    expect(platformSharePct(33.33)).toBe(66.67);
    expect(platformSharePct(12.5)).toBe(87.5);
  });
});

describe('classifyTerms', () => {
  it('marks the newest started term active and the rest superseded', () => {
    const out = classifyTerms(
      [
        term({ id: 'old', partnerSharePct: 20, effectiveFrom: new Date('2026-08-01T00:00:00Z') }),
        term({ id: 'new', partnerSharePct: 30, effectiveFrom: new Date('2026-09-01T00:00:00Z') }),
      ],
      NOW
    );
    expect(out.find((t) => t.id === 'new')?.status).toBe('active');
    expect(out.find((t) => t.id === 'old')?.status).toBe('superseded');
  });

  it('keeps a future-dated term scheduled until its start, without displacing the active one', () => {
    const out = classifyTerms(
      [
        term({ id: 'now', partnerSharePct: 30, effectiveFrom: new Date('2026-09-01T00:00:00Z') }),
        term({ id: 'nov', partnerSharePct: 40, effectiveFrom: new Date('2026-11-01T00:00:00Z') }),
      ],
      NOW
    );
    expect(out.find((t) => t.id === 'nov')?.status).toBe('scheduled');
    expect(out.find((t) => t.id === 'now')?.status).toBe('active');
  });

  it('judges each QR point separately from the partner default', () => {
    const out = classifyTerms(
      [
        term({ id: 'partner', partnerSharePct: 30 }),
        term({ id: 'kiosk', kioskId: KIOSK, partnerSharePct: 45 }),
      ],
      NOW
    );
    expect(out.find((t) => t.id === 'partner')?.status).toBe('active');
    expect(out.find((t) => t.id === 'kiosk')?.status).toBe('active');
  });

  it('breaks an identical start time by the time the term was written', () => {
    const same = new Date('2026-09-01T00:00:00Z');
    const out = classifyTerms(
      [
        term({
          id: 'first',
          partnerSharePct: 20,
          effectiveFrom: same,
          createdAt: new Date('2026-09-01T10:00:00Z'),
        }),
        term({
          id: 'second',
          partnerSharePct: 25,
          effectiveFrom: same,
          createdAt: new Date('2026-09-01T11:00:00Z'),
        }),
      ],
      NOW
    );
    expect(out.find((t) => t.id === 'second')?.status).toBe('active');
    expect(out.find((t) => t.id === 'first')?.status).toBe('superseded');
  });
});

describe('effectiveTerm', () => {
  it('uses a QR point override when one is active', () => {
    const classified = classifyTerms(
      [
        term({ id: 'partner', partnerSharePct: 30 }),
        term({ id: 'kiosk', kioskId: KIOSK, partnerSharePct: 45 }),
      ],
      NOW
    );
    const eff = effectiveTerm(classified, KIOSK);
    expect(eff?.source).toBe('qr_point');
    expect(eff?.term.partnerSharePct).toBe(45);
  });

  it('falls back to the partner default while a QR point override is only scheduled', () => {
    const classified = classifyTerms(
      [
        term({ id: 'partner', partnerSharePct: 30 }),
        term({
          id: 'kiosk',
          kioskId: KIOSK,
          partnerSharePct: 45,
          effectiveFrom: new Date('2026-12-01T00:00:00Z'),
        }),
      ],
      NOW
    );
    const eff = effectiveTerm(classified, KIOSK);
    expect(eff?.source).toBe('partner');
    expect(eff?.term.partnerSharePct).toBe(30);
  });

  it('returns null when no term has started for the partner', () => {
    const classified = classifyTerms(
      [term({ id: 'later', effectiveFrom: new Date('2026-12-01T00:00:00Z') })],
      NOW
    );
    expect(effectiveTerm(classified, KIOSK)).toBeNull();
  });
});

describe('RevenueSplitService', () => {
  let db: ScriptedDb;
  const service = (rules: Rule[]) => {
    db = scriptedDb(rules);
    return new RevenueSplitService(db as never);
  };

  describe('resolveTerm', () => {
    it('returns the term row the SQL picked, with the share as a number', async () => {
      const svc = service([
        ['FROM revenue_split_terms t', [{ id: 'T1', partner_share_pct: '30.00' }]],
      ]);
      await expect(svc.resolveTerm(db as never, ORG, KIOSK)).resolves.toEqual({
        termId: 'T1',
        partnerSharePct: 30,
      });
    });

    it('returns null when no term applies, so the sale stays unsplit', async () => {
      const svc = service([]);
      await expect(svc.resolveTerm(db as never, ORG, KIOSK)).resolves.toBeNull();
    });

    it('only considers terms for partners on Option A, and only once they have started', async () => {
      const svc = service([]);
      await svc.resolveTerm(db as never, ORG, KIOSK);
      const sql = db.query.mock.calls[0][0];
      expect(sql).toContain('o.business_model = $3');
      expect(sql).toContain('t.effective_from <= NOW()');
      expect(sql).toContain('(t.kiosk_id IS NULL OR t.kiosk_id = $2)');
      expect(sql).toContain('ORDER BY (t.kiosk_id IS NOT NULL) DESC');
    });
  });

  describe('snapshotPaidJob', () => {
    it('writes the split onto the job, with MPrnt’s share as the remainder', async () => {
      const svc = service([
        ['FROM print_jobs WHERE id', [{ organization_id: ORG, kiosk_id: KIOSK }]],
        ['FROM revenue_split_terms t', [{ id: 'T1', partner_share_pct: '30' }]],
        // One row matched: the sale was unsplit, and is now written.
        ['UPDATE print_jobs pj', [{ id: JOB }]],
      ]);

      await expect(svc.snapshotPaidJob(db as never, JOB)).resolves.toBe(true);

      const update = db.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE print_jobs'));
      expect(update).toBeDefined();
      const [sql, params] = update!;
      // Money is computed in Postgres NUMERIC. MPrnt's share is the total less the partner's rounded share, so they always add back to the sale.
      expect(sql).toContain('ROUND(pj.total_amount * $3 / 100, 2)');
      expect(sql).toContain('pj.total_amount - ROUND(pj.total_amount * $3 / 100, 2)');
      expect(sql).toContain('AND pj.split_term_id IS NULL');
      expect(params).toEqual([JOB, 'T1', 30]);
    });

    it('reports false, and the guard keeps the existing split, when the sale was already split', async () => {
      // The UPDATE matches no row for a sale that already has a split, so the
      // fake reports zero rows affected, as Postgres would.
      const svc = service([
        ['FROM print_jobs WHERE id', [{ organization_id: ORG, kiosk_id: KIOSK }]],
        ['FROM revenue_split_terms t', [{ id: 'T2', partner_share_pct: '45' }]],
      ]);
      await expect(svc.snapshotPaidJob(db as never, JOB)).resolves.toBe(false);
      const update = db.query.mock.calls.find(([sql]) => String(sql).includes('UPDATE print_jobs'));
      expect(String(update![0])).toContain('AND pj.split_term_id IS NULL');
    });

    it('leaves a sale unsplit, and writes nothing, when no term applies', async () => {
      const svc = service([
        ['FROM print_jobs WHERE id', [{ organization_id: ORG, kiosk_id: KIOSK }]],
      ]);
      await expect(svc.snapshotPaidJob(db as never, JOB)).resolves.toBe(false);
      expect(db.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE print_jobs'))).toBe(
        false
      );
    });

    it('leaves a sale with no partner attached unsplit', async () => {
      const svc = service([
        ['FROM print_jobs WHERE id', [{ organization_id: null, kiosk_id: null }]],
      ]);
      await expect(svc.snapshotPaidJob(db as never, JOB)).resolves.toBe(false);
    });
  });

  describe('setTerm', () => {
    const input = {
      organizationId: ORG,
      kioskId: null,
      partnerSharePct: 30,
      effectiveFrom: null,
      note: 'Signed 12 Oct',
      actorId: 'admin-1',
    };

    it('refuses a partner that is not on Option A, so no split is written against another model', async () => {
      const svc = service([['FROM organizations WHERE id', [{ business_model: 'integration' }]]]);
      const err = await svc.setTerm(input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBe(409);
      expect(
        db.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO revenue_split_terms'))
      ).toBe(false);
    });

    it('refuses a QR point that belongs to another partner', async () => {
      const svc = service([
        ['FROM organizations WHERE id', [{ business_model: 'revenue-share' }]],
        ['FROM kiosks WHERE id', [{ organization_id: 'someone-else' }]],
      ]);
      await expect(svc.setTerm({ ...input, kioskId: KIOSK_OTHER_ORG })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it('records the term with its note and the author, and reports the value it replaced', async () => {
      const svc = service([
        ['FROM organizations WHERE id', [{ business_model: 'revenue-share' }]],
        [
          'FROM revenue_split_terms t',
          [
            {
              id: 'OLD',
              kiosk_id: null,
              kiosk_name: null,
              partner_share_pct: '20',
              effective_from: new Date('2026-08-01T00:00:00Z'),
              note: 'earlier',
              created_at: new Date('2026-08-01T00:00:00Z'),
              created_by_email: null,
            },
          ],
        ],
        ['INSERT INTO revenue_split_terms', [{ id: 'NEW', effective_from: NOW }]],
      ]);

      const out = await svc.setTerm(input);

      expect(out).toEqual({ id: 'NEW', effectiveFrom: NOW, previous: 20 });
      const insert = db.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO revenue_split_terms')
      );
      expect(insert![1]).toEqual([ORG, null, 30, null, 'Signed 12 Oct', 'admin-1']);
    });
  });

  describe('getView', () => {
    const terms = [
      {
        id: 'P1',
        kiosk_id: null,
        kiosk_name: null,
        partner_share_pct: '30',
        effective_from: new Date('2026-09-01T00:00:00Z'),
        note: 'Agreement',
        created_at: new Date('2026-09-01T00:00:00Z'),
        created_by_email: 'root@mprnt.test',
      },
    ];

    it('shows the shop the figures but not who set them', async () => {
      const svc = service([
        ['FROM organizations WHERE id', [{ business_model: 'revenue-share' }]],
        ['FROM kiosks WHERE organization_id', [{ id: KIOSK, name: 'QR-1' }]],
        ['FROM revenue_split_terms t', terms],
      ]);

      const view = await svc.getView(ORG, false, NOW);

      expect(view.applies).toBe(true);
      expect(view.partnerDefault).toEqual({
        partnerSharePct: 30,
        platformSharePct: 70,
        effectiveFrom: '2026-09-01T00:00:00.000Z',
      });
      expect(view.byQrPoint[0]).toMatchObject({
        kioskName: 'QR-1',
        partnerSharePct: 30,
        source: 'partner',
      });
      expect(view.history[0]).not.toHaveProperty('createdBy');
    });

    it('names the author to the super admin', async () => {
      const svc = service([
        ['FROM organizations WHERE id', [{ business_model: 'revenue-share' }]],
        ['FROM kiosks WHERE organization_id', []],
        ['FROM revenue_split_terms t', terms],
      ]);
      const view = await svc.getView(ORG, true, NOW);
      expect(view.history[0].createdBy).toBe('root@mprnt.test');
    });

    it('reports applies=false for a partner off Option A, so the shop hides the split', async () => {
      const svc = service([
        ['FROM organizations WHERE id', [{ business_model: 'integration' }]],
        ['FROM kiosks WHERE organization_id', []],
        ['FROM revenue_split_terms t', []],
      ]);
      const view = await svc.getView(ORG, false, NOW);
      expect(view.applies).toBe(false);
      expect(view.partnerDefault).toBeNull();
    });
  });

  describe('getSummary', () => {
    it('splits the period’s paid revenue, and reports the part with no split apart', async () => {
      jest.spyOn(dashboardService, 'resolveRange').mockResolvedValue({
        from: '2026-10-01',
        to: '2026-10-13',
        timezone: 'Asia/Kolkata',
        period: 'month',
      });
      const svc = service([
        [
          'AS paid_jobs',
          [
            {
              paid_jobs: '10',
              split_jobs: '7',
              gross: '503.00',
              partner: '151.50',
              platform: '351.50',
              unsplit: '90.00',
            },
          ],
        ],
      ]);

      const out = await svc.getSummary(ORG, 'month');

      expect(out).toEqual({
        range: { from: '2026-10-01', to: '2026-10-13', timezone: 'Asia/Kolkata' },
        paidJobs: 10,
        splitJobs: 7,
        grossRevenue: 503,
        partnerRevenue: 151.5,
        platformRevenue: 351.5,
        unsplitRevenue: 90,
      });
      const summary = db.query.mock.calls.find(([sql]) => String(sql).includes('AS paid_jobs'));
      expect(String(summary![0])).toContain("pj.payment_status = 'paid'");
      expect(String(summary![0])).toContain('(pj.created_at AT TIME ZONE $2)::date <  $4::date');
    });
  });
});
