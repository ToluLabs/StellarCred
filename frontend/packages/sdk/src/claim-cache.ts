// Opt-in, in-memory memo for claim reads.
//
// Protocols that call `hasClaim` on every render otherwise send one RPC
// simulation per render. With `configure({ claimCache: true })` a repeated
// read of the same question — same wallet, credential type, threshold,
// trusted-issuer set and source — is answered locally until the TTL lapses.
//
// The store is deliberately dumb: claims.ts decides what is cacheable (only
// successful reads, never fail-soft `false`s) and when to bypass it.

export interface ClaimCacheKey {
  wallet: string;
  claimType: string;
  /** Present for `check_claim` reads; absent for plain `is_verified` reads. */
  minThreshold?: number;
  trustedIssuers?: readonly string[];
  source: string;
}

interface Entry {
  wallet: string;
  claimType: string;
  value: unknown;
  expiresAt: number;
}

/**
 * Serialises a key. `trustedIssuers` is order-insensitive (it is a set to the
 * contract), but `undefined` and `[]` stay distinct because the contract
 * receives `None` and `Some([])` respectively.
 */
export function claimCacheKey(key: ClaimCacheKey): string {
  const issuers = key.trustedIssuers ? Array.from(new Set(key.trustedIssuers)).sort() : null;
  return JSON.stringify([key.source, key.wallet, key.claimType, key.minThreshold ?? null, issuers]);
}

export class ClaimCache {
  private readonly entries = new Map<string, Entry>();
  private _generation = 0;

  /**
   * Bumped by every invalidate/clear. A read records it before going to the
   * network and passes it back to {@link set}; if an invalidation happened in
   * between, the (possibly pre-submission) result is not stored.
   */
  get generation(): number {
    return this._generation;
  }

  get size(): number {
    return this.entries.size;
  }

  get<T>(key: string, now = Date.now()): { value: T } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value as T };
  }

  set(
    key: string,
    meta: { wallet: string; claimType: string },
    value: unknown,
    expiresAt: number,
    maxEntries: number,
    generation: number,
    now = Date.now(),
  ): boolean {
    if (generation !== this._generation) return false;
    if (!(expiresAt > now) || !(maxEntries > 0)) return false;

    // Re-inserting moves the key to the end, so eviction below drops the
    // least recently written entry first.
    this.entries.delete(key);
    this.entries.set(key, { wallet: meta.wallet, claimType: meta.claimType, value, expiresAt });

    if (this.entries.size > maxEntries) {
      for (const [k, e] of this.entries) {
        if (e.expiresAt <= now) this.entries.delete(k);
      }
    }
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
    return true;
  }

  /**
   * Drops every entry for `wallet`, or only those for `claimType` when given.
   * Returns how many entries were removed.
   */
  invalidate(wallet: string, claimType?: string): number {
    this._generation += 1;
    let removed = 0;
    for (const [k, e] of this.entries) {
      if (e.wallet === wallet && (claimType === undefined || e.claimType === claimType)) {
        this.entries.delete(k);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this._generation += 1;
    this.entries.clear();
  }
}
