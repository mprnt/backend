/**
 * The printed QR stand for a QR point: the MPRNT artwork with the point's own
 * code in the middle. Everything except the code is fixed, so every stand looks
 * the same and only the QR changes.
 *
 * The QR encodes `<customer app>/?kioskId=<code>`, the same address the backend
 * script in mprnt-backend/scripts/generate-qr-codes.ts writes, and uses the same
 * high error correction, because stands get scuffed and photographed.
 */
import QRCode from 'qrcode';
import { MPRNT_LOGO } from './mprnt-logo';

/** The logo's own green, so the header and the logo's cut-outs match. */
export const GREEN = '#015037';
const CREAM = '#F6F4EE';
const WHITE = '#FFFFFF';

/** The artboard, drawn at this size. Export at a larger size for print; the artwork is vector. */
export const STAND_ARTBOARD = { width: 1200, height: 1800 } as const;

/** The customer app's address with no trailing slash, or '' when it has not been configured. */
export function customerAppBase(): string {
  return (process.env.NEXT_PUBLIC_CUSTOMER_APP_URL ?? '').replace(/\/+$/, '');
}

export function customerAppUrl(base: string, code: string): string {
  return `${base}/?kioskId=${encodeURIComponent(code)}`;
}

export async function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 2,
    color: { dark: GREEN, light: WHITE },
  });
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The file name for a stand, so a downloaded file says which partner and which QR point it belongs to. */
export function standFileName(partner: string, code: string): string {
  return `mprnt-stand-${slugify(partner) || 'partner'}-${slugify(code)}`;
}

/**
 * The stand as SVG. `qr` is the output of qrSvg(). `size` sets the width and height
 * the file is drawn at; the artwork itself always uses the artboard's coordinates.
 */
export function standSvg(
  qr: string,
  size: { width: number; height: number } = STAND_ARTBOARD
): string {
  // The generated SVG carries its own size and viewBox; keep its drawing and its
  // viewBox, and place it inside the artboard.
  const inner = qr.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
  const qrViewBox = qr.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1 1';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 1200 1800" role="img" aria-label="MPRNT scan to print stand">
  <rect width="1200" height="1800" fill="${CREAM}"/>

  <path d="M0 0 H1200 V320 C1090 320 990 430 860 430 H0 Z" fill="${GREEN}"/>

  <g transform="translate(600 40) scale(0.6947) translate(-516.5 -135)">${MPRNT_LOGO.markup}</g>
  <text x="600" y="396" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="25"
        letter-spacing="9" fill="${WHITE}">SMART PRINTING PLATFORM</text>

  <rect x="120" y="527" width="85" height="4" fill="${GREEN}"/>
  <rect x="995" y="527" width="85" height="4" fill="${GREEN}"/>
  <text x="600" y="560" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="800"
        font-size="80" letter-spacing="1" fill="${GREEN}">SCAN TO PRINT</text>
  <text x="600" y="632" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="500"
        font-size="34" letter-spacing="5" fill="${GREEN}">Quick  •  Easy  •  Hassle Free</text>

  <path d="M300 816 V752 Q300 720 332 720 H396 M804 720 H868 Q900 720 900 752 V816 M900 1224 V1288 Q900 1320 868 1320 H804 M396 1320 H332 Q300 1320 300 1288 V1224"
        fill="none" stroke="${GREEN}" stroke-width="16" stroke-linecap="round"/>
  <svg x="340" y="760" width="520" height="520" viewBox="${qrViewBox}" shape-rendering="crispEdges">${inner}</svg>

  <g fill="none" stroke="${GREEN}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(282 1352) scale(1.2)">
      <g transform="translate(2 -3)">
        <path d="M22 58 H18 A14 14 0 0 1 16 30 A20 20 0 0 1 54 26 A14 14 0 0 1 60 58 H56"/>
        <path d="M40 60 V36 M30 46 L40 36 L50 46"/>
      </g>
    </g>
    <g transform="translate(552 1352) scale(1.2)">
      <g transform="translate(0 3)">
        <path d="M26 34 V12 H54 V34"/>
        <rect x="14" y="34" width="52" height="28" rx="6"/>
        <rect x="26" y="50" width="28" height="20"/>
      </g>
    </g>
    <g transform="translate(822 1352) scale(1.2)">
      <path d="M40 12 L66 25 V55 L40 68 L14 55 V25 Z"/>
      <path d="M14 25 L40 38 L66 25 M40 38 V68"/>
    </g>
  </g>
  <text x="330" y="1478" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" letter-spacing="5" fill="${GREEN}">UPLOAD</text>
  <text x="600" y="1478" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" letter-spacing="5" fill="${GREEN}">PRINT</text>
  <text x="870" y="1478" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="28" letter-spacing="5" fill="${GREEN}">COLLECT</text>
  <circle cx="465" cy="1400" r="6" fill="${GREEN}"/>
  <circle cx="735" cy="1400" r="6" fill="${GREEN}"/>

  <rect x="120" y="1510" width="960" height="2" fill="#C5CEC7"/>

  <circle cx="260" cy="1578" r="42" fill="${GREEN}"/>
  <g fill="none" stroke="${WHITE}" stroke-width="3">
    <circle cx="260" cy="1578" r="28"/>
    <ellipse cx="260" cy="1578" rx="12" ry="28"/>
    <path d="M232 1578 H288"/>
  </g>
  <rect x="558" y="1536" width="84" height="84" rx="22" fill="${GREEN}"/>
  <g fill="none" stroke="${WHITE}" stroke-width="5">
    <rect x="572" y="1550" width="56" height="56" rx="16"/>
    <circle cx="600" cy="1578" r="14"/>
  </g>
  <circle cx="625" cy="1553" r="3.5" fill="${WHITE}"/>
  <rect x="898" y="1536" width="84" height="84" rx="14" fill="${GREEN}"/>
  <text x="940" y="1598" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="700"
        font-size="52" fill="${WHITE}">in</text>

  <rect x="430" y="1536" width="2" height="150" fill="#C5CEC7"/>
  <rect x="770" y="1536" width="2" height="150" fill="#C5CEC7"/>
  <text x="260" y="1666" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="36" fill="${GREEN}">mprnt.in</text>
  <text x="260" y="1702" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#4B6A59">Website</text>
  <text x="600" y="1666" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="36" fill="${GREEN}">@mprnt.in</text>
  <text x="600" y="1702" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#4B6A59">Instagram</text>
  <text x="940" y="1666" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-weight="600" font-size="36" fill="${GREEN}">/mprnt</text>
  <text x="940" y="1702" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="24" fill="#4B6A59">LinkedIn</text>

  <text x="600" y="1766" text-anchor="middle" font-family="Brush Script MT, Segoe Script, Snell Roman, cursive" font-style="italic"
        font-size="56" fill="${GREEN}" transform="rotate(-4 600 1766)">Print Smarter</text>

  <path d="M1200 1540 V1800 H880 Z" fill="${GREEN}"/>
  <g transform="translate(1046 1716) scale(0.7)" fill="none" stroke="${WHITE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 68 C12 30 36 12 70 10 C70 46 50 68 12 68 Z"/>
    <path d="M12 68 L44 36"/>
  </g>
</svg>
`;
}
