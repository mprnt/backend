/**
 * Generates one printable QR code per QR point.
 *
 *   npx ts-node scripts/generate-qr-codes.ts --base http://localhost:3001
 *   npx ts-node scripts/generate-qr-codes.ts --base http://192.168.0.102:3001
 *   npx ts-node scripts/generate-qr-codes.ts --base https://print.example.com --out ./qr
 *
 * A QR code encodes `<base>/?kioskId=<code>`, which is what the customer app
 * reads. One code per QR point, not per printer: a QR point is the place
 * people scan, and whichever printer there is free takes the job.
 *
 * Two files per point:
 *   <slug>.svg   a labelled card, ready to print and stick up
 *   <slug>.png   the bare code, for embedding elsewhere
 *
 * The card carries the partner, the place and the code, because six unlabelled
 * QR codes on a desk are indistinguishable and getting them the wrong way
 * round sends customers' jobs to another building.
 *
 * Reads whichever database DATABASE_URL points at, and only ever reads.
 *
 * For an environment whose database is not reachable from here - production,
 * typically - pass the point explicitly instead and no database is touched:
 *
 *   npx ts-node scripts/generate-qr-codes.ts --base https://mprnt-qr.vercel.app \
 *     --code M002 --name "Front counter" --partner "Shop 2" --location "Shop 2 · front counter"
 *
 * The code must match the QR point exactly, or the card will send customers to
 * a point that does not exist.
 */
import fs from 'fs';
import path from 'path';
import QRCode from 'qrcode';
import { db } from '../src/config/database';

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

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;'
  );
}

/**
 * A printable card: the code, who it belongs to, where it is, and the short
 * code itself so a person can match a sheet to a row in the dashboard.
 */
function card(qrSvg: string, point: PointRow): string {
  // The generated SVG carries its own width/height and viewBox; strip the
  // outer element so it can be placed inside this one.
  const inner = qrSvg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const viewBox = qrSvg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 41 41';

  const partner = escapeXml(point.partner ?? 'Unassigned');
  const place = escapeXml(point.name);
  const where = escapeXml(point.location ?? '');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560" viewBox="0 0 420 560" role="img"
     aria-label="QR code for ${partner}, ${place}">
  <rect width="420" height="560" rx="18" fill="#ffffff"/>
  <rect x="0.5" y="0.5" width="419" height="559" rx="17.5" fill="none" stroke="#e8e5df"/>

  <text x="210" y="56" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="13" letter-spacing="2.2" fill="#6b6862">SCAN TO PRINT</text>

  <svg x="50" y="86" width="320" height="320" viewBox="${viewBox}">${inner}</svg>

  <text x="210" y="452" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="24" font-weight="600" fill="#1c1b19">${place}</text>
  <text x="210" y="480" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="15" fill="#6b6862">${partner}</text>
  ${
    where
      ? `<text x="210" y="504" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="12" fill="#9a9790">${where}</text>`
      : ''
  }

  <text x="210" y="534" text-anchor="middle" font-family="ui-monospace, Menlo, monospace"
        font-size="13" letter-spacing="1.4" fill="#1a6240">${escapeXml(point.code)}</text>
</svg>
`;
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
    const url = `${base}/?kioskId=${encodeURIComponent(point.code)}`;
    const slug = `${slugify(point.partner ?? 'unassigned')}-${slugify(point.name)}-${slugify(point.code)}`;

    // High correction: these get printed, taped up and scuffed.
    const qrSvg = await QRCode.toString(url, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: 1,
    });

    fs.writeFileSync(path.join(outDir, `${slug}.svg`), card(qrSvg, point));
    await QRCode.toFile(path.join(outDir, `${slug}.png`), url, {
      width: 900,
      margin: 2,
      errorCorrectionLevel: 'H',
    });

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
