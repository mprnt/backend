/**
 * Builds the four test partners used to exercise the admin dashboard.
 *
 *   npx ts-node scripts/seed-test-partners.ts
 *
 * Refuses to run against anything but a local database: it renames and deletes
 * records, which must never touch a real deployment.
 *
 * The shape is chosen to cover every combination the dashboard has to render,
 * rather than to look realistic:
 *
 *   Shop 1  Model 1   1 QR point  · 2 printers           two machines sharing one queue
 *   Shop 2  Model 1   1 QR point  · 1 printer            the simplest case
 *   Shop 3  Model 2A  2 QR points · 1 printer, 1 station mixed hardware, separate areas
 *   Shop 4  Model 3   2 QR points · 2 printers, 2 stations  several devices per point
 *
 * That is 9 devices across 6 QR points, so 6 QR codes.
 *
 * QR point codes are kept to the API's own rule: 2-10 letters, digits or
 * hyphens, which is also the column width.
 *
 * Re-running is safe: partners are matched by name and their fleet rebuilt, so
 * the result is the same whether the database was empty or already seeded.
 */
/* eslint no-console: "off" */
import crypto from 'crypto';
import { db, QueryResultRow } from '../src/config/database';
import env from '../src/config/environment';
import { BusinessModelId } from '../src/types/businessModels';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

interface DeviceSpec {
  /** Suffix for the printer id, appended to the QR point code. */
  n: number;
  name: string;
  isStation: boolean;
  stationName?: string;
  color: boolean;
  duplex: boolean;
  /** 'online' | 'offline' | 'busy' - the status to leave it in. */
  status: string;
  paperLevel: number;
  inkLevel: number;
}

interface PointSpec {
  code: string;
  name: string;
  location: string;
  devices: DeviceSpec[];
}

interface PartnerSpec {
  name: string;
  businessModel: BusinessModelId;
  /** Matched first by this old name, so existing data is reused not duplicated. */
  renameFrom?: string;
  points: PointSpec[];
}

interface IdRow extends QueryResultRow {
  id: string;
}

interface KioskRow extends IdRow {
  kiosk_id: string;
}

interface OrganizationNameRow extends QueryResultRow {
  name: string;
}

interface TotalsRow extends QueryResultRow {
  partners: string;
  points: string;
  printers: string;
  stations: string;
  paid_jobs: string;
}

const PARTNERS: PartnerSpec[] = [
  {
    name: 'Shop 1',
    renameFrom: 'Default Organization',
    businessModel: 'integration',
    points: [
      {
        code: 'S1-DESK',
        name: 'Front counter',
        location: 'Shop 1 · main counter',
        devices: [
          {
            n: 1,
            name: 'Counter printer A',
            isStation: false,
            color: true,
            duplex: true,
            status: 'online',
            paperLevel: 72,
            inkLevel: 58,
          },
          // Busy, so the shared-queue behaviour is visible: a job arriving at
          // this QR point goes to printer A while B is mid-job.
          {
            n: 2,
            name: 'Counter printer B',
            isStation: false,
            color: false,
            duplex: true,
            status: 'busy',
            paperLevel: 24,
            inkLevel: 40,
          },
        ],
      },
    ],
  },
  {
    name: 'Shop 2',
    renameFrom: 'Report Test Shop',
    businessModel: 'integration',
    points: [
      {
        code: 'S2-DESK',
        name: 'Service desk',
        location: 'Shop 2 · service desk',
        devices: [
          {
            n: 1,
            name: 'Desk printer',
            isStation: false,
            color: false,
            duplex: false,
            status: 'online',
            paperLevel: 91,
            inkLevel: 77,
          },
        ],
      },
    ],
  },
  {
    name: 'Shop 3',
    businessModel: 'revenue-share',
    points: [
      {
        code: 'S3-LIB',
        name: 'Library floor',
        location: 'Shop 3 · library, ground floor',
        devices: [
          {
            n: 1,
            name: 'Library station printer',
            isStation: true,
            stationName: 'Library station',
            color: true,
            duplex: true,
            status: 'online',
            paperLevel: 66,
            inkLevel: 51,
          },
        ],
      },
      {
        code: 'S3-BACK',
        name: 'Back office',
        location: 'Shop 3 · back office',
        devices: [
          {
            n: 1,
            name: 'Back office printer',
            isStation: false,
            color: false,
            duplex: true,
            status: 'offline',
            paperLevel: 12,
            inkLevel: 30,
          },
        ],
      },
    ],
  },
  {
    name: 'Shop 4',
    businessModel: 'full-purchase',
    points: [
      {
        code: 'S4-GND',
        name: 'Ground floor',
        location: 'Shop 4 · ground floor atrium',
        devices: [
          {
            n: 1,
            name: 'Ground station printer',
            isStation: true,
            stationName: 'Atrium station',
            color: true,
            duplex: true,
            status: 'online',
            paperLevel: 83,
            inkLevel: 69,
          },
          {
            n: 2,
            name: 'Ground printer',
            isStation: false,
            color: false,
            duplex: true,
            status: 'online',
            paperLevel: 45,
            inkLevel: 62,
          },
        ],
      },
      {
        code: 'S4-FL1',
        name: 'First floor',
        location: 'Shop 4 · first floor study area',
        devices: [
          {
            n: 1,
            name: 'Study station printer',
            isStation: true,
            stationName: 'Study station',
            color: true,
            duplex: true,
            status: 'busy',
            paperLevel: 38,
            inkLevel: 44,
          },
          {
            n: 2,
            name: 'Study printer',
            isStation: false,
            color: true,
            duplex: false,
            status: 'offline',
            paperLevel: 8,
            inkLevel: 15,
          },
        ],
      },
    ],
  },
];

function assertLocal(): void {
  const url = env.database.url ? new URL(env.database.url) : null;
  const host = url ? url.hostname : env.database.host;
  if (!LOCAL_HOSTS.has(host)) {
    console.error(`Refusing to seed a non-local database: ${host}`);
    process.exit(1);
  }
  console.log(`Seeding ${host} — local, safe to rewrite.`);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** A printer id the Pi would send, following the RPI_<point>_<n> convention. */
function printerId(pointCode: string, n: number): string {
  return `RPI_${pointCode.replace(/-/g, '_')}_0${n}`;
}

async function upsertPartner(spec: PartnerSpec): Promise<string> {
  const found = await db.query<IdRow>(
    `SELECT id FROM organizations
      WHERE deleted_at IS NULL AND (name = $1 OR name = $2)
      ORDER BY (name = $1) DESC LIMIT 1`,
    [spec.name, spec.renameFrom ?? spec.name]
  );

  if (found.rows[0]) {
    await db.query(
      `UPDATE organizations
          SET name = $2, slug = $3, business_model = $4, status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [found.rows[0].id, spec.name, slugify(spec.name), spec.businessModel]
    );
    return found.rows[0].id;
  }

  const created = await db.query<IdRow>(
    `INSERT INTO organizations (name, slug, business_model, timezone, status)
     VALUES ($1, $2, $3, 'Asia/Kolkata', 'active') RETURNING id`,
    [spec.name, slugify(spec.name), spec.businessModel]
  );
  return created.rows[0].id;
}

async function upsertPoint(orgId: string, point: PointSpec): Promise<string> {
  const found = await db.query<IdRow>(`SELECT id FROM kiosks WHERE kiosk_id = $1`, [point.code]);

  if (found.rows[0]) {
    await db.query(
      `UPDATE kiosks SET name = $2, location = $3, organization_id = $4,
              status = 'active', updated_at = NOW()
        WHERE id = $1`,
      [found.rows[0].id, point.name, point.location, orgId]
    );
    return found.rows[0].id;
  }

  const created = await db.query<IdRow>(
    `INSERT INTO kiosks (kiosk_id, name, location, organization_id, status, capabilities,
                         created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'active', $5, NOW(), NOW()) RETURNING id`,
    [
      point.code,
      point.name,
      point.location,
      orgId,
      JSON.stringify({ color: true, duplex: true, paper_sizes: ['a4'] }),
    ]
  );
  return created.rows[0].id;
}

async function upsertDevice(pointId: string, pointCode: string, d: DeviceSpec): Promise<string> {
  const id = printerId(pointCode, d.n);

  // A non-null api_key_prefix is what the dashboard reads as "enrolled". The
  // hash is random: no real Pi is going to authenticate against this data.
  // The prefix is the key's first 16 characters, as printerAuthService makes
  // it, and the column is exactly that wide.
  const prefix = `mprnt_pk_${crypto.randomBytes(8).toString('base64url')}`.slice(0, 16);
  const heartbeat = d.status === 'offline' ? null : new Date();

  const found = await db.query<IdRow>(`SELECT id FROM printers WHERE printer_id = $1`, [id]);

  if (found.rows[0]) {
    await db.query(
      `UPDATE printers
          SET kiosk_id = $2, name = $3, status = $4, is_station = $5, station_name = $6,
              supports_color = $7, supports_double_sided = $8, last_heartbeat = $9,
              revoked_at = NULL, updated_at = NOW()
        WHERE id = $1`,
      [
        found.rows[0].id,
        pointId,
        d.name,
        d.status,
        d.isStation,
        d.stationName ?? null,
        d.color,
        d.duplex,
        heartbeat,
      ]
    );
  } else {
    await db.query(
      `INSERT INTO printers (printer_id, kiosk_id, name, status, is_station, station_name,
                             supports_color, supports_double_sided, max_copies,
                             supported_paper_sizes, api_key_hash, api_key_prefix,
                             api_key_issued_at, last_heartbeat, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 50, ARRAY['a4'], $9, $10, NOW(), $11, NOW(), NOW())`,
      [
        id,
        pointId,
        d.name,
        d.status,
        d.isStation,
        d.stationName ?? null,
        d.color,
        d.duplex,
        crypto.randomBytes(32).toString('hex'),
        prefix,
        heartbeat,
      ]
    );
  }

  const row = await db.query<IdRow>(`SELECT id FROM printers WHERE printer_id = $1`, [id]);
  const uuid = row.rows[0].id;

  // Consumable levels come from the latest heartbeat, not the printer row.
  await db.query(`DELETE FROM printer_heartbeats WHERE printer_id = $1`, [uuid]);
  if (d.status !== 'offline') {
    await db.query(
      `INSERT INTO printer_heartbeats (printer_id, status, paper_level, ink_level_black, received_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [uuid, d.status, d.paperLevel, d.inkLevel]
    );
  }

  return uuid;
}

/**
 * Paid print jobs spread over the last 30 days, so revenue reports have
 * something to show. Deterministic per device: the same seed run twice gives
 * the same figures, which makes a change in the dashboard meaningful.
 */
/**
 * Paid print jobs for one device, spread over the last 30 days.
 *
 * Each job is attributed to the device that printed it as it is created: the
 * queue row is what records which machine took the work, and it is what the
 * per-device revenue figures read. Attaching jobs in bulk afterwards would
 * hand every job at a QR point to whichever device was seeded last.
 *
 * Deterministic per device, so the same seed run twice gives the same figures
 * and a change on screen means something.
 */
/** Removes a QR point's jobs and their queue rows, before reseeding it. */
async function clearJobs(orgId: string, pointId: string): Promise<void> {
  const scope = `job_id IN (SELECT id FROM print_jobs WHERE kiosk_id = $1 AND organization_id = $2)`;
  await db.query(`DELETE FROM print_queue WHERE ${scope}`, [pointId, orgId]);
  await db.query(`DELETE FROM payment_refunds WHERE ${scope}`, [pointId, orgId]);
  await db.query(`DELETE FROM payment_orders WHERE ${scope}`, [pointId, orgId]);
  await db.query(`DELETE FROM print_jobs WHERE kiosk_id = $1 AND organization_id = $2`, [
    pointId,
    orgId,
  ]);
}

async function seedJobs(
  orgId: string,
  pointId: string,
  pointCode: string,
  printerUuid: string,
  deviceIndex: number,
  isStation: boolean
): Promise<void> {
  // A station sees more traffic than a back-office printer; the mix is what
  // makes comparing devices within one partner worth doing. The spread also
  // varies per QR point, so two devices of the same kind never show identical
  // figures - identical numbers look like a broken filter.
  const spread = pointCode.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % 5;
  const jobCount = (isStation ? 16 : 8) + deviceIndex * 4 + spread;

  for (let i = 0; i < jobCount; i++) {
    const daysAgo = Math.floor((i / jobCount) * 29);
    const pages = 2 + ((i * 7 + deviceIndex * 3) % 12);
    const color = i % 4 === 0;
    const rate = color ? 5 : 2;
    const amount = pages * rate;
    const failed = i % 11 === 0;

    // Timestamps are built here rather than in SQL: expressing them inline
    // made the status parameter serve as both a value and a comparison, which
    // Postgres cannot type.
    const createdAt = new Date(Date.now() - daysAgo * 86400_000);
    const completedAt = failed ? null : new Date(createdAt.getTime() + 120_000);

    const job = await db.query<IdRow>(
      `INSERT INTO print_jobs
         (kiosk_id, organization_id, color_mode, copies, base_price_per_page, total_pages,
          total_amount, status, payment_status, paid_at, created_at, completed_at,
          printed_pages, print_duration_seconds)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, 'paid', $8, $8, $9, $10, $11)
       RETURNING id`,
      [
        pointId,
        orgId,
        color ? 'color' : 'bw',
        rate,
        pages,
        amount,
        failed ? 'failed' : 'completed',
        createdAt,
        completedAt,
        failed ? 0 : pages,
        failed ? null : 40 + (i % 30),
      ]
    );

    // A failed job never printed, so it belongs to no device - it still counts
    // for the QR point and the partner. That gap is deliberate and is what the
    // dashboard explains when a device filter is applied.
    if (!failed) {
      await db.query(
        `INSERT INTO print_queue
           (job_id, printer_id, status, priority, queued_at, assigned_at, completed_at, printed_pages)
         VALUES ($1, $2, 'completed', 0, $3, $3, $4, $5)`,
        [job.rows[0].id, printerUuid, createdAt, completedAt, pages]
      );
    }
  }
}

/**
 * Removes QR points belonging to a seeded partner that are not in its spec,
 * together with everything hanging off them.
 *
 * Without this, a partner keeps whatever it had from earlier experiments and
 * the counts on screen never match the scenario being tested. Deletion order
 * is explicit because the financial tables deliberately do not cascade (see
 * migration 013).
 */
async function pruneFleet(orgId: string, keepCodes: string[]): Promise<string[]> {
  const stale = await db.query<KioskRow>(
    `SELECT id, kiosk_id FROM kiosks
      WHERE organization_id = $1 AND NOT (kiosk_id = ANY($2::text[]))`,
    [orgId, keepCodes]
  );
  if (stale.rows.length === 0) return [];

  const ids = stale.rows.map((r: { id: string }) => r.id);

  await db.query(
    `DELETE FROM print_queue WHERE job_id IN (SELECT id FROM print_jobs WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(
    `DELETE FROM print_queue WHERE printer_id IN (SELECT id FROM printers WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  // Payments deliberately do not cascade from a job (migration 013), so they
  // are cleared explicitly. Only ever reached for local test data.
  const jobScope = `job_id IN (SELECT id FROM print_jobs WHERE kiosk_id = ANY($1::uuid[]))`;
  await db.query(`DELETE FROM payment_refunds WHERE ${jobScope}`, [ids]);
  await db.query(`DELETE FROM payment_orders WHERE ${jobScope}`, [ids]);
  await db.query(
    `DELETE FROM payments WHERE print_job_id IN (SELECT id FROM print_jobs WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(
    `UPDATE printer_heartbeats SET current_job_id = NULL
      WHERE current_job_id IN (SELECT id FROM print_jobs WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(`DELETE FROM print_jobs WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(
    `DELETE FROM documents WHERE session_id IN (SELECT id FROM print_sessions WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(
    `DELETE FROM payments WHERE session_id IN (SELECT id FROM print_sessions WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(
    `DELETE FROM analytics_events WHERE session_id IN (SELECT id FROM print_sessions WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(`DELETE FROM print_sessions WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM analytics_events WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM daily_stats WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM price_lists WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(
    `DELETE FROM printer_heartbeats WHERE printer_id IN (SELECT id FROM printers WHERE kiosk_id = ANY($1::uuid[]))`,
    [ids]
  );
  await db.query(`DELETE FROM printers WHERE kiosk_id = ANY($1::uuid[])`, [ids]);
  await db.query(`DELETE FROM kiosks WHERE id = ANY($1::uuid[])`, [ids]);

  return stale.rows.map((r: { kiosk_id: string }) => r.kiosk_id);
}

async function main(): Promise<void> {
  assertLocal();

  for (const partner of PARTNERS) {
    const orgId = await upsertPartner(partner);
    console.log(`\n${partner.name}  (${partner.businessModel})`);

    const removed = await pruneFleet(
      orgId,
      partner.points.map((p) => p.code)
    );
    if (removed.length > 0) console.log(`  removed stale QR points: ${removed.join(', ')}`);

    for (const point of partner.points) {
      const pointId = await upsertPoint(orgId, point);
      console.log(`  QR point ${point.code} — ${point.name}`);

      // Cleared once per QR point, not per device: clearing inside the device
      // loop wiped the previous device's jobs, leaving every figure on the
      // last one seeded.
      await clearJobs(orgId, pointId);

      let index = 0;
      for (const device of point.devices) {
        const uuid = await upsertDevice(pointId, point.code, device);
        const label = device.isStation ? `station "${device.stationName}"` : 'printer';
        console.log(`    ${printerId(point.code, device.n)}  ${label}  ${device.status}`);
        await seedJobs(orgId, pointId, point.code, uuid, index, device.isStation);
        index++;
      }
    }
  }

  // Anything left from earlier experiments would muddle the counts.
  const stale = await db.query<OrganizationNameRow>(
    `SELECT name FROM organizations
      WHERE deleted_at IS NULL AND name NOT IN (${PARTNERS.map((_, i) => `$${i + 1}`).join(',')})`,
    PARTNERS.map((p) => p.name)
  );
  if (stale.rows.length > 0) {
    console.log(`\nOther partners still present: ${stale.rows.map((r) => r.name).join(', ')}`);
  }

  const totals = await db.query<TotalsRow>(
    `SELECT (SELECT COUNT(*) FROM organizations WHERE deleted_at IS NULL) AS partners,
            (SELECT COUNT(*) FROM kiosks)   AS points,
            (SELECT COUNT(*) FROM printers) AS printers,
            (SELECT COUNT(*) FROM printers WHERE is_station) AS stations,
            (SELECT COUNT(*) FROM print_jobs WHERE payment_status = 'paid') AS paid_jobs`
  );
  const t = totals.rows[0];
  console.log(
    `\nDone: ${t.partners} partners · ${t.points} QR points · ${t.printers} printers ` +
      `(${t.stations} of them stations) · ${t.paid_jobs} paid jobs`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
