import { MemoryRateLimiter } from '../rate-limiter';

describe('MemoryRateLimiter (#70)', () => {
  let limiter: MemoryRateLimiter;

  beforeEach(() => {
    limiter = new MemoryRateLimiter();
  });

  it('allows requests within IP limit and blocks when exceeded', () => {
    const ip = '192.168.1.50';
    
    // Limit = 2 per minute
    const r1 = limiter.checkIp(ip, 2, 60000);
    expect(r1.allowed).toBe(true);

    const r2 = limiter.checkIp(ip, 2, 60000);
    expect(r2.allowed).toBe(true);

    const r3 = limiter.checkIp(ip, 2, 60000);
    expect(r3.allowed).toBe(false);
    expect(r3.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('allows requests within wallet limit and blocks when exceeded', () => {
    const wallet = 'GBC...WALLET';

    // Limit = 1 per hour
    const r1 = limiter.checkWallet(wallet, 1, 3600000);
    expect(r1.allowed).toBe(true);

    const r2 = limiter.checkWallet(wallet, 1, 3600000);
    expect(r2.allowed).toBe(false);
    expect(r2.retryAfterSeconds).toBeGreaterThan(0);
  });
});
