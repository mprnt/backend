import { cacheService, CacheKeys } from '../../src/services/cacheService';

describe('cacheService (in-memory)', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    await cacheService.flush();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(async () => {
    await cacheService.close();
  });

  it('returns what was stored', async () => {
    await cacheService.set('k', { pages: 3, name: 'a.pdf' });
    await expect(cacheService.get('k')).resolves.toEqual({ pages: 3, name: 'a.pdf' });
    await expect(cacheService.exists('k')).resolves.toBe(true);
  });

  it('returns null for a missing key', async () => {
    await expect(cacheService.get('missing')).resolves.toBeNull();
    await expect(cacheService.exists('missing')).resolves.toBe(false);
  });

  it('expires entries after their TTL', async () => {
    await cacheService.set('k', 'v', 10);

    jest.advanceTimersByTime(9_999);
    await expect(cacheService.get('k')).resolves.toBe('v');

    jest.advanceTimersByTime(1);
    await expect(cacheService.get('k')).resolves.toBeNull();
    await expect(cacheService.exists('k')).resolves.toBe(false);
  });

  it('resets the TTL when a key is set again', async () => {
    await cacheService.set('k', 'old', 10);
    jest.advanceTimersByTime(8_000);
    await cacheService.set('k', 'new', 10);
    jest.advanceTimersByTime(8_000);

    await expect(cacheService.get('k')).resolves.toBe('new');
  });

  it('drops expired entries from the stats count', async () => {
    await cacheService.set('short', 1, 1);
    await cacheService.set('long', 2, 100);
    jest.advanceTimersByTime(2_000);

    await expect(cacheService.getStats()).resolves.toMatchObject({ connected: true, dbSize: 1 });
  });

  it('evicts the oldest entry once past 1000 entries', async () => {
    for (let i = 0; i <= 1000; i++) await cacheService.set(`k${i}`, i);

    await expect(cacheService.get('k0')).resolves.toBeNull();
    await expect(cacheService.get('k1')).resolves.toBe(1);
    await expect(cacheService.get('k1000')).resolves.toBe(1000);
    expect((await cacheService.getStats()).dbSize).toBe(1000);
  });

  it('treats a re-set key as newest when choosing what to evict', async () => {
    for (let i = 0; i < 1000; i++) await cacheService.set(`k${i}`, i);
    await cacheService.set('k0', 'refreshed');
    await cacheService.set('overflow', true);

    await expect(cacheService.get('k0')).resolves.toBe('refreshed');
    await expect(cacheService.get('k1')).resolves.toBeNull();
  });

  it('is not affected by mutating a stored or returned object', async () => {
    const original = { tags: ['a'] };
    await cacheService.set('k', original);
    original.tags.push('b');

    const first = await cacheService.get<{ tags: string[] }>('k');
    expect(first).toEqual({ tags: ['a'] });
    first!.tags.push('c');

    await expect(cacheService.get('k')).resolves.toEqual({ tags: ['a'] });
  });

  it('deletes one key or several', async () => {
    await cacheService.set('a', 1);
    await cacheService.set('b', 2);
    await cacheService.set('c', 3);

    await cacheService.del('a');
    await cacheService.del(['b', 'c']);

    expect((await cacheService.getStats()).dbSize).toBe(0);
  });

  it('builds namespaced keys', () => {
    expect(CacheKeys.preview('d1')).toBe('preview:d1');
    expect(CacheKeys.sessionDocument('s1')).toBe('session:s1:document');
  });
});
