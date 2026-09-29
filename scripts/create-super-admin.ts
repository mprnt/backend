/**
 * Creates or resets a platform super admin.
 *
 * Super admins are deliberately not creatable over HTTP: the account can change
 * every shop's pricing and read every shop's revenue, so creating one requires
 * shell access to the server. There is no bootstrap endpoint and no default
 * account to forget about.
 *
 *   npx ts-node scripts/create-super-admin.ts admin@example.com "Full Name"
 *
 * The password is generated and printed once. Re-running for an existing
 * address resets that account's password rather than creating a duplicate.
 */
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { db } from '../src/config/database';
import env from '../src/config/environment';

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  const fullName = process.argv[3] || 'Super Admin';

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: npx ts-node scripts/create-super-admin.ts <email> ["Full Name"]');
    process.exit(1);
  }

  const password = generatePassword();
  const hash = await bcrypt.hash(password, env.security.bcrypt_rounds);

  const existing = await db.query(
    `SELECT id, role FROM admin_users WHERE lower(email) = lower($1) AND deleted_at IS NULL`,
    [email]
  );

  if (existing.rows.length > 0) {
    if (existing.rows[0].role !== 'super_admin') {
      console.error(
        `✗ ${email} already exists as a '${existing.rows[0].role}'. ` +
          'Use a different address rather than escalating a shop account.'
      );
      process.exit(1);
    }

    await db.query(
      `UPDATE admin_users
          SET password_hash = $2, must_change_password = true,
              failed_login_attempts = 0, locked_until = NULL,
              is_active = true, password_changed_at = NOW(), updated_at = NOW()
        WHERE id = $1`,
      [existing.rows[0].id, hash]
    );

    // Any session opened with the old password is now invalid.
    await db.query(
      `UPDATE admin_refresh_tokens SET revoked_at = NOW()
        WHERE admin_user_id = $1 AND revoked_at IS NULL`,
      [existing.rows[0].id]
    );

    console.log(`\n✓ Password reset for existing super admin ${email}`);
  } else {
    await db.query(
      `INSERT INTO admin_users (
         email, password_hash, full_name, role, organization_id,
         is_active, must_change_password, created_at, updated_at
       ) VALUES ($1, $2, $3, 'super_admin', NULL, true, true, NOW(), NOW())`,
      [email.toLowerCase(), hash, fullName]
    );

    console.log(`\n✓ Super admin created: ${email}`);
  }

  console.log('\n  Password (shown once — store it in a password manager now):\n');
  console.log(`    ${password}\n`);
  console.log('  You will be required to change it on first sign-in.\n');

  process.exit(0);
}

main().catch((error) => {
  console.error('✗ Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
