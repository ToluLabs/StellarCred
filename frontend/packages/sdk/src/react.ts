import { useState, useEffect, useCallback, useRef } from "react";
import { hasClaims, type ClaimType } from "./claims";

/**
 * Configuration options for the `useStellarCred` React hook.
 *
 * @example
 * ```tsx
 * const { claims } = useStellarCred(wallet, {
 *   claims: ["kyc", "age"],
 *   minThresholds: { age: 21 },
 * });
 * ```
 */
export interface UseStellarCredOptions {
  claims?: ClaimType[];
    /**
   * Minimum thresholds for parameterized claims.
   *
   * Example:
   * {
   *   age: 21,
   *   funds: 50000,
   * }
   */
  minThresholds?: Partial<Record<ClaimType, number>>;
}

/**
 * Result returned by the `useStellarCred` React hook.
 *
 * @example
 * ```tsx
 * const { claims, loading, error, refetch } = useStellarCred(wallet);
 * ```
 */
export interface UseStellarCredResult {
  claims: Partial<Record<ClaimType, boolean>> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * React hook for checking StellarCred claims for a wallet.
 *
 * The hook automatically fetches claim verification status when the wallet
 * changes and exposes loading, error, and refetch state.
 *
 * @param wallet Stellar wallet address, or `null` when disconnected.
 * @param options Optional configuration for which claims to check.
 *
 * @returns Current claim status, loading state, any error, and a refetch function.
 *
 * @example
 * ```tsx
 * const { claims, loading } = useStellarCred(wallet, {
 *   claims: ["kyc", "age"],
 * });
 * ```
 */
export function useStellarCred(
  wallet: string | null,
  options?: UseStellarCredOptions
): UseStellarCredResult {
  const [claims, setClaims] = useState<Partial<Record<ClaimType, boolean>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetchClaims = useCallback(async () => {
    if (!wallet) {
      setClaims(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const typesToCheck: ClaimType[] =
        options?.claims || ["kyc", "age", "jurisdiction", "income", "funds", "accreditation", "composite"];

      // One batched read shares a single client across all types; per-type
      // failures resolve to `false` inside `hasClaims`.
      const results = await hasClaims(wallet, typesToCheck, {
        minThresholds: options?.minThresholds,
      });

      if (mountedRef.current) {
        setClaims(results);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error("Failed to check claims"));
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [wallet, JSON.stringify(options?.claims)]);

  useEffect(() => {
    mountedRef.current = true;
    fetchClaims();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchClaims]);

  return { claims, loading, error, refetch: fetchClaims };
}
