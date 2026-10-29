import { encryptAccountNumber } from '../utils/payoutCrypto';

/**
 * Who set a detail, as the platform records it. 'platform' is MPRNT (a super admin
 * or the onboarding wizard); 'shop' is the shop's own owner or manager.
 */
export type DetailsScope = 'platform' | 'shop';

/**
 * A shop's bank and UPI details as they are written. Every field is optional, so a shop
 * can add them one at a time. A field left out is not touched; a field sent as null or
 * an empty string is cleared.
 */
export interface PayoutInput {
  bankAccountHolder?: string | null;
  bankName?: string | null;
  bankAccountNumber?: string | null;
  bankIfsc?: string | null;
  upiId?: string | null;
}

export const PAYOUT_FIELDS = [
  'bankAccountHolder',
  'bankName',
  'bankAccountNumber',
  'bankIfsc',
  'upiId',
] as const;

/** True when the input names at least one payout field, so an update has something to change. */
export function hasPayoutFields(input: PayoutInput | null | undefined): boolean {
  if (!input) return false;
  return PAYOUT_FIELDS.some((field) => input[field] !== undefined);
}

export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Adds the SET clauses for a payout update to `sets`, binding their values into `args`.
 * `args` already holds the organization id at position $1. The account number is
 * encrypted here, and only its last four digits are kept beside it in clear.
 */
export function addPayoutAssignments(
  input: PayoutInput,
  scope: DetailsScope,
  args: unknown[],
  sets: string[]
): void {
  const assign = (column: string, value: unknown) => {
    args.push(value);
    sets.push(`${column} = $${args.length}`);
  };

  if (input.bankAccountHolder !== undefined)
    assign('bank_account_holder', cleanText(input.bankAccountHolder));
  if (input.bankName !== undefined) assign('bank_name', cleanText(input.bankName));
  if (input.bankIfsc !== undefined) {
    const ifsc = cleanText(input.bankIfsc);
    assign('bank_ifsc', ifsc ? ifsc.toUpperCase() : null);
  }
  if (input.upiId !== undefined) assign('upi_id', cleanText(input.upiId));
  if (input.bankAccountNumber !== undefined) {
    const digits = cleanText(input.bankAccountNumber)?.replace(/\s+/g, '') ?? null;
    if (digits === null) {
      assign('bank_account_last4', null);
      assign('bank_account_number_enc', null);
    } else {
      assign('bank_account_last4', digits.slice(-4));
      assign('bank_account_number_enc', encryptAccountNumber(digits));
    }
  }

  assign('payout_updated_by_scope', scope);
  sets.push('payout_updated_at = NOW()');
}
