/**
 * Model 1 billing rules, as pure functions.
 *
 * Everything here works on calendar dates in India time ('YYYY-MM-DD'), never
 * on instants. A subscription month is a calendar period, and "due on the 1st"
 * means the 1st in India, whatever the server's own clock or timezone says.
 * Keeping this pure means every date rule can be tested without a database.
 *
 * Definitions (Model 1, as agreed):
 *   - The clock starts on the go-live date.
 *   - Subscription month k covers [go-live + (k-1) months, go-live + k months - 1 day].
 *   - The first `freeMonths` months are free. Each later month is billed in
 *     advance, due on its first day.
 *   - A charge becomes overdue only after its due date plus the grace days.
 */

const IST = 'Asia/Kolkata';
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Today's calendar date in India, as YYYY-MM-DD. */
export function istDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function parts(ymd: string): { y: number; m: number; d: number } {
  const match = DATE_RE.exec(ymd);
  if (!match) throw new Error(`Not a YYYY-MM-DD date: ${ymd}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new Error(`Not a real calendar date: ${ymd}`);
  }
  return { y, m, d };
}

function format(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Adds whole calendar months, clamping to the end of a shorter month:
 * 31 Jan + 1 month = 28 Feb (29 in a leap year). Always computed from the
 * anchor, never from the previous result, so the day of month cannot drift.
 */
export function addMonths(ymd: string, months: number): string {
  const { y, m, d } = parts(ymd);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const nd = Math.min(d, daysInMonth(ny, nm));
  return format(ny, nm, nd);
}

/** Adds whole days. */
export function addDays(ymd: string, days: number): string {
  const { y, m, d } = parts(ymd);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return format(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Whole days from a to b (b - a). Negative when b is earlier. */
export function daysBetween(a: string, b: string): number {
  const pa = parts(a);
  const pb = parts(b);
  const ta = Date.UTC(pa.y, pa.m - 1, pa.d);
  const tb = Date.UTC(pb.y, pb.m - 1, pb.d);
  return Math.round((tb - ta) / 86_400_000);
}

export interface Period {
  /** 1-based subscription month. */
  index: number;
  start: string;
  /** Inclusive last day. */
  end: string;
  /** False for a free month. */
  billable: boolean;
}

export interface ScheduleInput {
  goLiveOn: string;
  freeMonths: number;
}

/** The subscription month `index` (1-based), with its free or billable status. */
export function periodFor(input: ScheduleInput, index: number): Period {
  if (!Number.isInteger(index) || index < 1) throw new Error('Subscription months start at 1');
  const start = addMonths(input.goLiveOn, index - 1);
  const end = addDays(addMonths(input.goLiveOn, index), -1);
  return { index, start, end, billable: index > input.freeMonths };
}

/**
 * The billable months that have begun by `today` and so should have a charge
 * row. A month whose first day is still ahead is not charged yet.
 *
 * Catches up on every month that has begun, so a server that was down for a
 * week still creates the charge for each missed month, each with its own
 * due date.
 */
export function billablePeriodsDue(input: ScheduleInput, today: string): Period[] {
  const out: Period[] = [];
  for (let index = input.freeMonths + 1; index < 1000; index++) {
    const period = periodFor(input, index);
    if (period.start > today) break;
    out.push(period);
  }
  return out;
}

/** Overdue only once the grace period after the due date has fully passed. */
export function isOverdue(dueOn: string, graceDays: number, today: string): boolean {
  return daysBetween(addDays(dueOn, graceDays), today) > 0;
}

/**
 * The first day of the first month that is not yet covered by a payment or a
 * waiver, walking the months in order. A later month paid while an earlier one
 * is still owed does not count as covering the earlier one.
 *
 * `covered` lists the subscription months settled as paid or waived.
 */
export function paidThrough(input: ScheduleInput, covered: ReadonlySet<number>): string {
  let index = 1;
  while (index <= input.freeMonths || covered.has(index)) index++;
  return addDays(periodFor(input, index).start, -1);
}

export type ContractPhase =
  'awaiting_hardware' | 'not_live' | 'free' | 'active' | 'payment_due' | 'overdue';

export interface PhaseInput {
  hardwareSettled: boolean;
  goLiveOn: string | null;
  freeMonths: number;
  today: string;
  /** Software charges still owed, with their due dates. */
  owed: Array<{ dueOn: string }>;
  graceDays: number;
}

/**
 * Where a partner is in its lifecycle, read from the dates and the charges.
 * Overdue takes priority over payment due, and both over ordinary states.
 */
export function contractPhase(input: PhaseInput): ContractPhase {
  if (!input.hardwareSettled) return 'awaiting_hardware';
  if (!input.goLiveOn) return 'not_live';
  if (input.owed.some((c) => isOverdue(c.dueOn, input.graceDays, input.today))) return 'overdue';
  if (input.owed.length > 0) return 'payment_due';
  const freeEnd = addDays(addMonths(input.goLiveOn, input.freeMonths), -1);
  if (input.today <= freeEnd) return 'free';
  return 'active';
}
