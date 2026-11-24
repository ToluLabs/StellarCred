/**
 * db-router.ts — PostgreSQL read-replica routing middleware.
 *
 * Directs read-only SELECT queries to configured PostgreSQL read replicas using
 * round-robin load balancing while preserving all writes, DDL, locking reads,
 * and multi-statement batches on the primary database.
 *
 * When a replica fails to serve a read query, the router automatically fails
 * over to the next replica and, if all replicas are unavailable, falls back to
 * the primary database (configurable via `fallbackToPrimary`).
 */

import type { SqlParam } from "./db-dialect";
import type { PostgresConnection } from "./db-postgres";

export interface ReadReplicaRouterOptions {
  /**
   * When true (default), if every configured read replica fails for a read
   * query, the router retries the query against the primary database.
   */
  fallbackToPrimary?: boolean;
  /** Optional hook invoked when a replica query fails before failover/fallback. */
  onReplicaError?: (replicaIndex: number, error: unknown) => void;
}

export interface ReadReplicaRouterStats {
  primaryQueries: number;
  replicaQueries: number;
  replicaFailovers: number;
  primaryFallbacks: number;
  replicaCount: number;
}

export interface ReadReplicaRouter extends PostgresConnection {
  /** Snapshot of query routing counters for observability and testing. */
  getStats(): ReadReplicaRouterStats;
}

/**
 * Strip single-quoted string literals so keyword/semicolon checks never
 * misfire on user data (e.g. a wallet or description containing "UPDATE" or ";").
 */
function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''");
}

/**
 * Strip leading whitespace and SQL comments (`-- ...` and `/* ... *\/`).
 */
function stripLeadingComments(sql: string): string {
  let rest = sql;
  for (;;) {
    rest = rest.trimStart();
    if (rest.startsWith("--")) {
      const nl = rest.indexOf("\n");
      rest = nl === -1 ? "" : rest.slice(nl + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2);
      continue;
    }
    return rest;
  }
}

const WRITE_OR_MUTATING_PATTERN =
  /\b(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|LOCK|CALL|DO|SET|RETURNING)\b/i;

const ROW_LOCKING_PATTERN =
  /\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+(?:KEY\s+)?SHARE\b/i;

const SEQUENCE_MUTATION_PATTERN = /\b(?:nextval|setval)\s*\(/i;

/**
 * Return true iff `sql` is a single, pure read-only query safe to route to a
 * PostgreSQL read replica.
 *
 * Conservative by design: anything ambiguous, multi-statement, locking, or
 * mutating is classified as non-read-only so it always executes on primary.
 */
export function isReadOnlyQuery(sql: string): boolean {
  const cleaned = stripLeadingComments(sql);
  if (!cleaned) return false;

  const withoutStrings = stripStringLiterals(cleaned);
  // Remove a single optional trailing semicolon; any remaining semicolon means
  // a multi-statement batch, which must stay on primary.
  const withoutTrailingSemi = withoutStrings.replace(/;\s*$/, "");
  if (withoutTrailingSemi.includes(";")) {
    return false;
  }

  // Only SELECT and read-only WITH (CTE) queries are eligible for replicas.
  if (!/^(?:SELECT|WITH)\b/i.test(withoutTrailingSemi)) {
    return false;
  }

  if (WRITE_OR_MUTATING_PATTERN.test(withoutTrailingSemi)) {
    return false;
  }

  if (ROW_LOCKING_PATTERN.test(withoutTrailingSemi)) {
    return false;
  }

  if (SEQUENCE_MUTATION_PATTERN.test(withoutTrailingSemi)) {
    return false;
  }

  return true;
}

/**
 * Wrap a primary PostgreSQL connection and zero or more read replicas behind a
 * single {@link PostgresConnection} routing middleware.
 */
export function createReadReplicaRouter(
  primary: PostgresConnection,
  replicas: readonly PostgresConnection[],
  options: ReadReplicaRouterOptions = {},
): ReadReplicaRouter {
  const fallbackToPrimary = options.fallbackToPrimary ?? true;
  const replicaList = [...replicas];

  let nextReplicaIndex = 0;
  let primaryQueries = 0;
  let replicaQueries = 0;
  let replicaFailovers = 0;
  let primaryFallbacks = 0;

  return {
    async query(text: string, values?: SqlParam[]): Promise<{ rows: unknown[] }> {
      if (replicaList.length === 0 || !isReadOnlyQuery(text)) {
        primaryQueries += 1;
        return primary.query(text, values);
      }

      const startIndex = nextReplicaIndex;
      nextReplicaIndex = (nextReplicaIndex + 1) % replicaList.length;

      let lastError: unknown;
      for (let attempt = 0; attempt < replicaList.length; attempt += 1) {
        const replicaIndex = (startIndex + attempt) % replicaList.length;
        try {
          const result = await replicaList[replicaIndex].query(text, values);
          replicaQueries += 1;
          return result;
        } catch (err) {
          lastError = err;
          options.onReplicaError?.(replicaIndex, err);
          if (attempt + 1 < replicaList.length) {
            replicaFailovers += 1;
          }
        }
      }

      if (fallbackToPrimary) {
        primaryFallbacks += 1;
        primaryQueries += 1;
        return primary.query(text, values);
      }

      throw lastError;
    },

    async end(): Promise<void> {
      const results = await Promise.allSettled([
        primary.end(),
        ...replicaList.map((r) => r.end()),
      ]);
      const rejected = results.find(
        (r): r is PromiseRejectedResult => r.status === "rejected",
      );
      if (rejected) {
        throw rejected.reason;
      }
    },

    getStats(): ReadReplicaRouterStats {
      return {
        primaryQueries,
        replicaQueries,
        replicaFailovers,
        primaryFallbacks,
        replicaCount: replicaList.length,
      };
    },
  };
}
