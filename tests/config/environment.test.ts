import env, {
  Environment,
  missingProductionSettings,
  parseOrigins,
  positiveInt,
} from '../../src/config/environment';

describe('positiveInt', () => {
  it('reads a positive integer', () => {
    expect(positiveInt('10', 15)).toBe(10);
  });

  it.each([undefined, '', 'abc', '0', '-5'])('falls back for %p', (value) => {
    expect(positiveInt(value, 15)).toBe(15);
  });
});

describe('parseOrigins (CORS_ORIGIN)', () => {
  it('trims spaces around commas', () => {
    expect(parseOrigins('https://a.example.com, https://b.example.com')).toEqual([
      'https://a.example.com',
      'https://b.example.com',
    ]);
  });

  it('drops empty entries', () => {
    expect(parseOrigins(' https://a.example.com ,, ,')).toEqual(['https://a.example.com']);
  });

  it('keeps a single origin as is', () => {
    expect(parseOrigins('http://localhost:3000')).toEqual(['http://localhost:3000']);
  });
});

describe('missingProductionSettings', () => {
  const config = (payment: Partial<Environment['payment']>): Environment => ({
    ...env,
    jwt: { ...env.jwt, secret: 'a-real-secret' },
    printer: { ...env.printer, provisioning_token: 'token' },
    payment: {
      ...env.payment,
      razorpay_key_id: 'rzp_live_abc',
      razorpay_key_secret: 'secret',
      razorpay_webhook_secret: 'whsec',
      allow_test_payments: false,
      ...payment,
    },
  });

  it('accepts a live key', () => {
    expect(missingProductionSettings(config({}))).toEqual([]);
  });

  it('rejects a test key unless ALLOW_TEST_PAYMENTS is set', () => {
    expect(missingProductionSettings(config({ razorpay_key_id: 'rzp_test_abc' }))).toEqual([
      expect.stringContaining('RAZORPAY_KEY_ID'),
    ]);
  });

  it('accepts a test key with ALLOW_TEST_PAYMENTS', () => {
    expect(
      missingProductionSettings(
        config({ razorpay_key_id: 'rzp_test_abc', allow_test_payments: true })
      )
    ).toEqual([]);
  });

  it('still rejects a missing key with ALLOW_TEST_PAYMENTS, which would mean mock payments', () => {
    expect(
      missingProductionSettings(config({ razorpay_key_id: '', allow_test_payments: true }))
    ).toEqual([expect.stringContaining('RAZORPAY_KEY_ID')]);
  });

  it('requires the webhook secret, or closed-browser payments never queue', () => {
    expect(missingProductionSettings(config({ razorpay_webhook_secret: '' }))).toEqual([
      'RAZORPAY_WEBHOOK_SECRET',
    ]);
  });

  it('still requires the key secret', () => {
    expect(missingProductionSettings(config({ razorpay_key_secret: '' }))).toEqual([
      'RAZORPAY_KEY_SECRET',
    ]);
  });
});
