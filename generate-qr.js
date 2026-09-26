const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

// Config
const VERCEL_URL = process.env.VERCEL_URL || 'https://your-app.vercel.app';
const KIOSK_ID = process.env.KIOSK_ID || 'KIOSK_001';

// Generate URL
const printingUrl = `${VERCEL_URL}?kioskId=${KIOSK_ID}`;

console.log(`Generating QR code for: ${printingUrl}`);

// Generate QR codes in different formats
Promise.all([
  // PNG
  QRCode.toFile(
    path.join(__dirname, `qr-${KIOSK_ID}.png`),
    printingUrl,
    { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } }
  ),
  // SVG
  QRCode.toFile(
    path.join(__dirname, `qr-${KIOSK_ID}.svg`),
    printingUrl,
    { width: 300, type: 'image/svg+xml' }
  ),
]).then(() => {
  console.log(`✓ QR codes generated:`);
  console.log(`  - qr-${KIOSK_ID}.png`);
  console.log(`  - qr-${KIOSK_ID}.svg`);
}).catch(err => console.error('Error:', err));
