/**
 * Generates one printable QR stand per QR point.
 *
 *   npx ts-node scripts/generate-qr-codes.ts --base http://localhost:3001
 *   npx ts-node scripts/generate-qr-codes.ts --base http://192.168.0.102:3001
 *   npx ts-node scripts/generate-qr-codes.ts --base https://print.example.com --out ./qr
 *
 * A QR code encodes `<base>/?kioskId=<code>`, which is what the customer app
 * reads. One code per QR point, not per printer: a QR point is the place
 * people scan, and whichever printer there is free takes the job.
 *
 * The stand is the MPRNT artwork with this point's QR in it, the same design the
 * super-admin's onboarding screen makes (scripts/qr-stand/ is a copy of it).
 *
 * Two files per point:
 *   <slug>.svg   the stand as vector, for any print size
 *   <slug>.png   the stand at print size, 8 × 12 in at 300 dpi
 *
 * The stand shows only the QR, as the design requires. The file name carries the
 * partner, the place and the code, and the list printed for each point repeats
 * them, so a stand can be matched to its point before it goes up.
 *
 * Reads whichever database DATABASE_URL points at, and only ever reads.
 *
 * For an environment whose database is not reachable from here - production,
 * typically - pass the point explicitly instead and no database is touched:
 *
 *   npx ts-node scripts/generate-qr-codes.ts --base https://mprnt-qr.vercel.app \
 *     --code M002 --name "Front counter" --partner "Shop 2" --location "Shop 2 · front counter"
 *
 * The code must match the QR point exactly, or the stand will send customers to
 * a point that does not exist.
 */
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { db } from '../src/config/database';
import { customerAppUrl, qrSvg, slugify, standSvg } from './qr-stand/qr-stand';

/** 8 × 12 in at 300 dpi, the size a stand is printed at. */
const PRINT_SIZE = { width: 2400, height: 3600 } as const;

interface PointRow {
  code: string;
  name: string;
  location: string | null;
  status: string;
  partner: string | null;
  printers: string;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const base = (arg('--base') || process.env.QR_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.error(
      'Usage: npx ts-node scripts/generate-qr-codes.ts --base <customer app url> [--out <dir>]\n' +
        '  e.g. --base http://localhost:3001            (this machine only)\n' +
        '       --base http://192.168.0.102:3001        (phones on the same Wi-Fi)\n' +
        '       --base https://print.example.com        (deployed)'
    );
    process.exit(1);
  }

  const outDir = path.resolve(arg('--out') || 'qr-codes');
  fs.mkdirSync(outDir, { recursive: true });

  // Explicit mode: everything needed is on the command line, so the database
  // is never opened. This is how production codes are made from a machine that
  // cannot reach the production database.
  const explicitCode = arg('--code');
  const rows: PointRow[] = explicitCode
    ? [
        {
          code: explicitCode,
          name: arg('--name') || explicitCode,
          location: arg('--location') ?? null,
          status: 'active',
          partner: arg('--partner') ?? null,
          printers: '-',
        },
      ]
    : (
        await db.query<PointRow>(
          `SELECT k.kiosk_id AS code, k.name, k.location, k.status,
            o.name AS partner,
            (SELECT COUNT(*) FROM printers p
              WHERE p.kiosk_id = k.id AND p.revoked_at IS NULL) AS printers
       FROM kiosks k
       LEFT JOIN organizations o ON o.id = k.organization_id AND o.deleted_at IS NULL
      ORDER BY o.name NULLS LAST, k.kiosk_id`
        )
      ).rows;

  if (rows.length === 0) {
    console.error('No QR points found in this database.');
    process.exit(1);
  }

  const host = (() => {
    try {
      return new URL(base).host;
    } catch {
      return base;
    }
  })();
  console.log(`Customer app: ${base}\nWriting to:   ${outDir}\n`);

  for (const point of rows) {
    const url = customerAppUrl(base, point.code);
    const slug = `${slugify(point.partner ?? 'unassigned')}-${slugify(point.name)}-${slugify(point.code)}`;

    // High correction is set in the QR itself: these get printed, put up and scuffed.
    const qr = await qrSvg(url);

    fs.writeFileSync(path.join(outDir, `${slug}.svg`), standSvg(qr));
    // The SVG declares its size in px, so sharp draws it at exactly PRINT_SIZE.
    await sharp(Buffer.from(standSvg(qr, PRINT_SIZE)))
      .png()
      .toFile(path.join(outDir, `${slug}.png`));

    const counted = point.printers !== '-';
    const printers = parseInt(point.printers, 10) || 0;
    const warn = counted && printers === 0 ? '  ⚠ no printer enrolled' : '';
    const inactive = point.status !== 'active' ? `  ⚠ ${point.status}` : '';
    console.log(
      `${point.code.padEnd(10)} ${(point.partner ?? 'Unassigned').padEnd(22)} ` +
        `${point.name.padEnd(18)} ${counted ? `${printers} printer(s)` : ''}${warn}${inactive}`
    );
    console.log(`${' '.repeat(10)} ${slug}.svg / .png  →  ${url}`);
  }

  console.log(
    `\n${rows.length} QR point(s). Each code points at ${host}; regenerate if that changes.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
