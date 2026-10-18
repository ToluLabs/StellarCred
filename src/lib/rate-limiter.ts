export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export class MemoryRateLimiter {
  private ipStore = new Map<string, { count: number; resetTime: number }>();
  private walletStore = new Map<string, { count: number; resetTime: number }>();

  public checkIp(ip: string, limit: number = 20, windowMs: number = 60000): RateLimitResult {
    const now = Date.now();
    let record = this.ipStore.get(ip);
    
    if (!record || now > record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
      this.ipStore.set(ip, record);
    }

    record.count++;
    if (record.count > limit) {
      const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  public checkWallet(wallet: string, limit: number = 10, windowMs: number = 3600000): RateLimitResult {
    const now = Date.now();
    let record = this.walletStore.get(wallet);
    
    if (!record || now > record.resetTime) {
      record = { count: 0, resetTime: now + windowMs };
      this.walletStore.set(wallet, record);
    }

    record.count++;
    if (record.count > limit) {
      const retryAfterSeconds = Math.ceil((record.resetTime - now) / 1000);
      return { allowed: false, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }
}

export const globalRateLimiter = new MemoryRateLimiter();
