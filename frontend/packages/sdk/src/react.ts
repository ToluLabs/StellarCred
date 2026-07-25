import { useState, useEffect, useCallback, useRef } from "react";
import { StellarCred } from "./index";

export type ClaimType = "kyc" | "age" | "jurisdiction" | "income" | "funds" | "accreditation";

interface UseStellarCredOptions {
  claims?: ClaimType[];
  minThresholds?: Partial<Record<ClaimType, number>>;
}

interface UseStellarCredResult {
  claims: Partial<Record<ClaimType, boolean>> | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

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
      const typesToCheck = options?.claims || ["kyc", "age", "jurisdiction", "income", "funds", "accreditation"];
      const results: Partial<Record<ClaimType, boolean>> = {};

      await Promise.all(
        typesToCheck.map(async (claimType) => {
          try {
            const hasClaim = await StellarCred.hasClaim(wallet, claimType);
            if (mountedRef.current) {
              results[claimType] = hasClaim;
            }
          } catch {
            if (mountedRef.current) {
              results[claimType] = false;
            }
          }
        })
      );

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

