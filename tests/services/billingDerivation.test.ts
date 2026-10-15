import {
  ChargeRecord,
  ContractRecord,
  ContractView,
  deriveContract,
  invoiceLabel,
  toInvoice,
  toShopContract,
} from '../../src/services/billingService';

const PLAN = { hardwarePrice: 18999, monthlyPrice: 499, freeMonths: 1, graceDays: 5 };

const contract = (
  over: Partial<ContractRecord> = {},
  plan: Partial<typeof PLAN> = {}
): ContractRecord => ({
  goLiveOn: '2026-10-01',
  soldOn: '2026-09-25',
  saleNote: 'Sold to Shop 3 at the counter',
  goLiveNote: 'Installed and printing',
  soldByEmail: 'sales@mprnt.test',
  goLiveByEmail: 'ops@mprnt.test',
  plan: { ...PLAN, ...plan },
  ...over,
});

const hardware = (status: ChargeRecord['status'] = 'paid'): ChargeRecord => ({
  id: 'hw-1',
  kind: 'hardware',
  periodIndex: 0,
  periodStart: '2026-09-25',
  periodEnd: '2026-09-25',
  amount: 18999,
  dueOn: '2026-09-25',
  status,
  settledOn: status === 'due' ? null : '2026-09-25',
  paymentMethod: status === 'paid' ? 'upi' : null,
  paymentReference: status === 'paid' ? 'UTR987654' : null,
  settleNote: status === 'waived' ? 'Launch offer' : null,
  settledByEmail: status === 'due' ? null : 'accounts@mprnt.test',
});

const software = (
  index: number,
  status: ChargeRecord['status'],
  start: string,
  end: string
): ChargeRecord => ({
  id: `sw-${index}`,
  kind: 'software',
  periodIndex: index,
  periodStart: start,
  periodEnd: end,
  amount: 499,
  dueOn: start,
  status,
  settledOn: status === 'due' ? null : start,
  paymentMethod: status === 'paid' ? 'bank_transfer' : null,
  paymentReference: status === 'paid' ? 'NEFT-5544' : null,
  settleNote: status === 'waived' ? 'Goodwill' : null,
  settledByEmail: status === 'due' ? null : 'accounts@mprnt.test',
});

const NOV = software(2, 'due', '2026-11-01', '2026-11-30');
const DEC = software(3, 'due', '2026-12-01', '2026-12-31');

describe('deriveContract: the lifecycle of one partner', () => {
  it('awaiting the hardware: nothing else applies, the hardware is what is due', () => {
    const d = deriveContract(contract({ goLiveOn: null }), [hardware('due')], '2026-09-26');
    expect(d.phase).toBe('awaiting_hardware');
    expect(d.nextPayment).toEqual({
      amount: 18999,
      dueOn: '2026-09-25',
      periodIndex: null,
      kind: 'hardware',
    });
    expect(d.freeUntil).toBeNull();
    expect(d.paidThrough).toBeNull();
  });

  it('hardware paid but no go-live yet: not live, and no software is owed', () => {
    const d = deriveContract(contract({ goLiveOn: null }), [hardware('paid')], '2026-09-30');
    expect(d.phase).toBe('not_live');
    expect(d.nextPayment).toBeNull();
    expect(d.owed).toEqual([]);
  });

  it('live in the free month: free, no bill, next payment is month 2 on its first day', () => {
    const d = deriveContract(contract(), [hardware('paid')], '2026-10-15');
    expect(d.phase).toBe('free');
    expect(d.freeUntil).toBe('2026-10-31');
    expect(d.paidThrough).toBe('2026-10-31');
    expect(d.owed).toEqual([]);
    expect(d.nextPayment).toEqual({
      amount: 499,
      dueOn: '2026-11-01',
      periodIndex: 2,
      kind: 'software',
    });
  });

  it('on the first day of month 2 with its charge raised: payment due, in grace', () => {
    const d = deriveContract(contract(), [hardware('paid'), NOV], '2026-11-03');
    expect(d.phase).toBe('payment_due');
    expect(d.owed.map((o) => [o.charge.periodIndex, o.overdue])).toEqual([[2, false]]);
    expect(d.nextPayment).toEqual({
      amount: 499,
      dueOn: '2026-11-01',
      periodIndex: 2,
      kind: 'software',
    });
    expect(d.paidThrough).toBe('2026-10-31');
  });

  it('past the grace period: overdue, with the days it is overdue', () => {
    // Due 1 Nov, grace 5 days: last grace day 6 Nov, so 9 Nov is three days past it.
    const d = deriveContract(contract(), [hardware('paid'), NOV], '2026-11-09');
    expect(d.phase).toBe('overdue');
    expect(d.owed[0].overdue).toBe(true);
    expect(d.owed[0].daysOverdue).toBe(3);
  });

  it('month 2 paid: active, paid through November, and the next payment is December with no row yet', () => {
    const paidNov = software(2, 'paid', '2026-11-01', '2026-11-30');
    const d = deriveContract(contract(), [hardware('paid'), paidNov], '2026-11-10');
    expect(d.phase).toBe('active');
    expect(d.paidThrough).toBe('2026-11-30');
    expect(d.owed).toEqual([]);
    expect(d.nextPayment).toEqual({
      amount: 499,
      dueOn: '2026-12-01',
      periodIndex: 3,
      kind: 'software',
    });
  });

  it('a waived month counts as covered, the same as a paid one', () => {
    const waivedNov = software(2, 'waived', '2026-11-01', '2026-11-30');
    const d = deriveContract(contract(), [hardware('paid'), waivedNov], '2026-11-10');
    expect(d.paidThrough).toBe('2026-11-30');
    expect(d.phase).toBe('active');
  });

  it('paying December while November is still owed does not cover November', () => {
    const paidDec = software(3, 'paid', '2026-12-01', '2026-12-31');
    const d = deriveContract(contract(), [hardware('paid'), NOV, paidDec], '2026-12-02');
    expect(d.paidThrough).toBe('2026-10-31');
    expect(d.owed.map((o) => o.charge.periodIndex)).toEqual([2]);
    expect(d.nextPayment?.periodIndex).toBe(2);
    expect(d.phase).toBe('overdue');
  });

  it('the earliest owed charge is the next payment, even when several are owed', () => {
    const d = deriveContract(contract(), [hardware('paid'), NOV, DEC], '2026-12-02');
    expect(d.owed.map((o) => o.charge.periodIndex)).toEqual([2, 3]);
    expect(d.nextPayment?.periodIndex).toBe(2);
    expect(d.nextPayment?.dueOn).toBe('2026-11-01');
  });

  it('with no free months, the first month is billed from go-live', () => {
    const firstMonth = software(1, 'due', '2026-10-01', '2026-10-31');
    const d = deriveContract(
      contract({}, { freeMonths: 0 }),
      [hardware('paid'), firstMonth],
      '2026-10-01'
    );
    expect(d.phase).toBe('payment_due');
    expect(d.freeUntil).toBeNull();
    expect(d.nextPayment?.periodIndex).toBe(1);
  });

  it('a waived hardware charge counts as settled, so the partner can go live', () => {
    const d = deriveContract(contract({ goLiveOn: null }), [hardware('waived')], '2026-09-30');
    expect(d.phase).toBe('not_live');
  });

  it('an unsettled hardware charge keeps the partner in awaiting_hardware even if a go-live date is somehow present', () => {
    const d = deriveContract(contract(), [hardware('due')], '2026-10-15');
    expect(d.phase).toBe('awaiting_hardware');
  });

  it('a free-forever plan (monthly price 0) never bills and has no next payment', () => {
    const d = deriveContract(contract({}, { monthlyPrice: 0 }), [hardware('paid')], '2026-12-01');
    expect(d.owed).toEqual([]);
    expect(d.nextPayment).toBeNull();
  });
});

describe('a charge is owed only once it is due', () => {
  it('a charge row dated after today is not owed yet, even though it is unpaid', () => {
    const d = deriveContract(
      contract(),
      [hardware('paid'), software(3, 'due', '2026-12-01', '2026-12-31')],
      '2026-11-15'
    );
    expect(d.owed).toEqual([]);
    expect(d.phase).toBe('active');
    expect(d.nextPayment).toEqual({
      amount: 499,
      dueOn: '2026-11-01',
      periodIndex: 2,
      kind: 'software',
    });
  });
});

describe('invoices and labels', () => {
  it('labels the hardware and names the month a software charge covers', () => {
    expect(invoiceLabel(hardware('paid'))).toBe('Printer integration kit');
    expect(invoiceLabel(NOV)).toBe('Software, November 2026');
  });

  it('marks an unpaid charge past its grace as overdue, and a paid one as paid', () => {
    expect(toInvoice(NOV, 5, '2026-11-09', false).status).toBe('overdue');
    expect(toInvoice(NOV, 5, '2026-11-03', false).status).toBe('due');
    const paid = toInvoice(software(2, 'paid', '2026-11-01', '2026-11-30'), 5, '2026-11-09', false);
    expect(paid.status).toBe('paid');
    expect(paid.paidOn).toBe('2026-11-01');
  });

  it('shows the shop no payment reference, no payer and no note', () => {
    const inv = toInvoice(software(2, 'paid', '2026-11-01', '2026-11-30'), 5, '2026-11-09', false);
    expect(inv).not.toHaveProperty('paymentReference');
    expect(inv).not.toHaveProperty('settledByEmail');
    expect(inv).not.toHaveProperty('settleNote');
    expect(inv).not.toHaveProperty('paymentMethod');
  });

  it('gives a super admin the payment method, reference and payer', () => {
    const inv = toInvoice(software(2, 'paid', '2026-11-01', '2026-11-30'), 5, '2026-11-09', true);
    expect(inv.paymentReference).toBe('NEFT-5544');
    expect(inv.paymentMethod).toBe('bank_transfer');
    expect(inv.settledByEmail).toBe('accounts@mprnt.test');
  });
});

describe('toShopContract: the partner sees its own bill and nothing internal', () => {
  const INTERNAL_KEYS = [
    'saleNote',
    'goLiveNote',
    'soldByEmail',
    'goLiveByEmail',
    'paymentReference',
    'paymentMethod',
    'settleNote',
    'settledByEmail',
    'graceDays',
    'periodIndex',
    'hardware',
    'charges',
    'owed',
    'email',
  ];

  function fullView(today: string): ContractView {
    const charges = [hardware('paid'), software(2, 'paid', '2026-11-01', '2026-11-30'), DEC];
    const derived = deriveContract(contract(), charges, today);
    return {
      ...derived,
      invoices: charges.map((c) => toInvoice(c, PLAN.graceDays, today, false)),
      terms: PLAN,
      soldOn: '2026-09-25',
      saleNote: 'internal sale note',
      goLiveNote: 'internal go-live note',
      soldByEmail: 'sales@mprnt.test',
      goLiveByEmail: 'ops@mprnt.test',
    };
  }

  it('contains none of the internal fields, at any depth', () => {
    const shop = JSON.stringify(toShopContract(fullView('2026-12-02')));
    for (const key of INTERNAL_KEYS) {
      // A key, not a value: the word "hardware" is legitimately an invoice kind.
      expect(shop).not.toContain(`"${key}":`);
    }
    expect(shop).not.toContain('@mprnt.test');
    expect(shop).not.toContain('NEFT-5544');
    expect(shop).not.toContain('internal');
  });

  it('strips internal fields even when handed an invoice list that still carries them', () => {
    // Defence in depth: the shop projection must not depend on the caller having
    // already removed the internal invoice fields.
    const internal = fullView('2026-12-02');
    const shop = JSON.stringify(toShopContract(internal));
    expect(shop).not.toContain('NEFT-5544');
    expect(shop).not.toContain('accounts@mprnt.test');
    expect(shop).not.toContain('"paymentReference":');
    expect(shop).not.toContain('"settledByEmail":');
  });

  it('still tells the partner everything it needs to pay', () => {
    const shop = toShopContract(fullView('2026-12-02'));
    expect(shop).toMatchObject({
      phase: 'payment_due',
      goLiveOn: '2026-10-01',
      freeUntil: '2026-10-31',
      paidThrough: '2026-11-30',
      terms: { hardwarePrice: 18999, monthlyPrice: 499, freeMonths: 1 },
      gstInclusive: true,
    });
    expect(shop.nextPayment).toEqual({ amount: 499, dueOn: '2026-12-01', kind: 'software' });
    expect(shop.invoices.map((i) => i.status)).toEqual(['paid', 'paid', 'due']);
  });
});
