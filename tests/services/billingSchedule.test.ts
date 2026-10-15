import {
  addDays,
  addMonths,
  billablePeriodsDue,
  contractPhase,
  daysBetween,
  istDate,
  isOverdue,
  paidThrough,
  periodFor,
} from '../../src/services/billingSchedule';

describe('istDate', () => {
  it('reads the calendar date in India, not UTC', () => {
    // 19:00 UTC on 31 Oct is 00:30 on 1 Nov in India.
    expect(istDate(new Date('2026-10-31T19:00:00Z'))).toBe('2026-11-01');
    // 18:29 UTC on 31 Oct is still 23:59 on 31 Oct in India.
    expect(istDate(new Date('2026-10-31T18:29:00Z'))).toBe('2026-10-31');
  });
});

describe('addMonths', () => {
  it('clamps to the end of a shorter month rather than rolling over', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-03-31', 1)).toBe('2026-04-30');
    expect(addMonths('2026-08-31', 1)).toBe('2026-09-30');
  });

  it('handles a leap February', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonths('2027-01-31', 1)).toBe('2027-02-28');
  });

  it('anchors on the start, so the day does not drift after a clamped month', () => {
    // Stepping from 31 Jan one month at a time would give 28 Feb, then 28 Mar.
    // Anchored, the third month is 31 Mar again.
    expect(addMonths('2026-01-31', 2)).toBe('2026-03-31');
    expect(addMonths('2026-01-31', 3)).toBe('2026-04-30');
  });

  it('rolls the year forward and back', () => {
    expect(addMonths('2026-11-15', 2)).toBe('2027-01-15');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('rejects something that is not a real date', () => {
    expect(() => addMonths('2026-02-30', 1)).toThrow();
    expect(() => addMonths('2026-13-01', 1)).toThrow();
    expect(() => addMonths('01-10-2026', 1)).toThrow();
  });
});

describe('addDays and daysBetween', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('counts whole days, negative when going back', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
    expect(daysBetween('2026-10-01', '2026-10-01')).toBe(0);
  });
});

describe('periodFor', () => {
  it('runs each month from the go-live date to the day before the next', () => {
    expect(periodFor({ goLiveOn: '2026-10-01', freeMonths: 1 }, 1)).toEqual({
      index: 1,
      start: '2026-10-01',
      end: '2026-10-31',
      billable: false,
    });
    expect(periodFor({ goLiveOn: '2026-10-01', freeMonths: 1 }, 2)).toEqual({
      index: 2,
      start: '2026-11-01',
      end: '2026-11-30',
      billable: true,
    });
  });

  it('for a go-live on the 31st, each month still starts on its own last day, not on the 28th', () => {
    const input = { goLiveOn: '2026-01-31', freeMonths: 0 };
    expect(periodFor(input, 2)).toMatchObject({ start: '2026-02-28', end: '2026-03-30' });
    expect(periodFor(input, 3)).toMatchObject({ start: '2026-03-31', end: '2026-04-29' });
  });

  it('refuses month numbers below 1', () => {
    expect(() => periodFor({ goLiveOn: '2026-10-01', freeMonths: 1 }, 0)).toThrow();
  });
});

describe('billablePeriodsDue', () => {
  const input = { goLiveOn: '2026-10-01', freeMonths: 1 };

  it('creates nothing while only the free month has run', () => {
    expect(billablePeriodsDue(input, '2026-10-31')).toEqual([]);
  });

  it('creates the second month on its first day, not before', () => {
    expect(billablePeriodsDue(input, '2026-10-31')).toHaveLength(0);
    expect(billablePeriodsDue(input, '2026-11-01').map((p) => p.index)).toEqual([2]);
  });

  it('catches up on every month that has begun, so downtime loses no charge', () => {
    // Server down from 1 Nov to 1 Jan: months 2, 3 and 4 have all begun.
    const due = billablePeriodsDue(input, '2027-01-01');
    expect(due.map((p) => [p.index, p.start])).toEqual([
      [2, '2026-11-01'],
      [3, '2026-12-01'],
      [4, '2027-01-01'],
    ]);
  });

  it('with no free months, the first month is billed from go-live', () => {
    const paid = { goLiveOn: '2026-10-01', freeMonths: 0 };
    expect(billablePeriodsDue(paid, '2026-10-01').map((p) => p.index)).toEqual([1]);
  });

  it('is empty before go-live and for a go-live in the future', () => {
    expect(billablePeriodsDue(input, '2026-09-30')).toEqual([]);
  });
});

describe('isOverdue', () => {
  it('is not overdue on the due date, nor through the whole grace period', () => {
    expect(isOverdue('2026-11-01', 5, '2026-11-01')).toBe(false);
    expect(isOverdue('2026-11-01', 5, '2026-11-05')).toBe(false);
    // Due 1 Nov with 5 grace days: the last grace day is 6 Nov, overdue from 7 Nov.
    expect(isOverdue('2026-11-01', 5, '2026-11-06')).toBe(false);
    expect(isOverdue('2026-11-01', 5, '2026-11-07')).toBe(true);
  });

  it('with zero grace, overdue the day after the due date', () => {
    expect(isOverdue('2026-11-01', 0, '2026-11-01')).toBe(false);
    expect(isOverdue('2026-11-01', 0, '2026-11-02')).toBe(true);
  });
});

describe('paidThrough', () => {
  const input = { goLiveOn: '2026-10-01', freeMonths: 1 };

  it('is the end of the free month before anything is paid', () => {
    expect(paidThrough(input, new Set())).toBe('2026-10-31');
  });

  it('moves on contiguously as months are paid', () => {
    expect(paidThrough(input, new Set([2]))).toBe('2026-11-30');
    expect(paidThrough(input, new Set([2, 3]))).toBe('2026-12-31');
  });

  it('does not count a later month as covering an earlier unpaid one', () => {
    // Month 3 is paid but month 2 is still owed: cover stops before month 2.
    expect(paidThrough(input, new Set([3]))).toBe('2026-10-31');
  });

  it('treats a waived month as covered', () => {
    expect(paidThrough(input, new Set([2]))).toBe('2026-11-30');
  });
});

describe('contractPhase', () => {
  const base = {
    hardwareSettled: true,
    goLiveOn: '2026-10-01',
    freeMonths: 1,
    today: '2026-10-15',
    owed: [] as Array<{ dueOn: string }>,
    graceDays: 5,
  };

  it('waits for the hardware before anything else', () => {
    expect(contractPhase({ ...base, hardwareSettled: false, goLiveOn: null })).toBe(
      'awaiting_hardware'
    );
    expect(contractPhase({ ...base, hardwareSettled: false })).toBe('awaiting_hardware');
  });

  it('is not live until a go-live date is recorded', () => {
    expect(contractPhase({ ...base, goLiveOn: null })).toBe('not_live');
  });

  it('is free through the free month, and active once the free month has ended', () => {
    expect(contractPhase({ ...base, today: '2026-10-31' })).toBe('free');
    expect(contractPhase({ ...base, today: '2026-11-01' })).toBe('active');
  });

  it('is payment due within the grace period, and overdue after it', () => {
    const owed = [{ dueOn: '2026-11-01' }];
    expect(contractPhase({ ...base, today: '2026-11-03', owed })).toBe('payment_due');
    expect(contractPhase({ ...base, today: '2026-11-06', owed })).toBe('payment_due');
    expect(contractPhase({ ...base, today: '2026-11-07', owed })).toBe('overdue');
  });

  it('overdue outranks payment due when both apply', () => {
    const owed = [{ dueOn: '2026-11-01' }, { dueOn: '2026-11-20' }];
    expect(contractPhase({ ...base, today: '2026-11-21', owed })).toBe('overdue');
  });
});
