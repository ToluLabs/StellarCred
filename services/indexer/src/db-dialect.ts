/**
 * db-dialect.ts — The thin adapter between the shared query layer and a driver.
 *
 * Everything in `db-shared.ts` is written once, in ordinary SQL, against this
 * interface. The only things a backend gets to decide are the ones that are
 * genuinely different between SQLite and Postgres:
 *
 *   - how a bind parameter is spelled (`?` vs `$1`, `$2`, …)
 *   - how a statement's result set is read back (driver-specific)
 *   - how an inserted row's new id is recovered (`lastInsertRowid` vs `RETURNING`)
 *   - the handful of DDL/type expressions that differ (`INTEGER PRIMARY KEY
 *     AUTOINCREMENT` vs `SERIAL PRIMARY KEY`, `datetime('now')` vs `now()`, …)
 *   - how a database that predates the `claims.id` cursor is upgraded
 *
 * If a new field lands here, it is a dialect difference — anything else belongs
 * in the shared layer.
 */

export type SqlParam = string | number | null;

export interface SqlDialect {
  /** Driver name, used in error messages only. */
  readonly name: "sqlite" | "postgres";

  // ── Statement execution ────────────────────────────────────────────────
  //
  // Every method takes SQL written with `?` placeholders plus the values to
  // bind; the adapter renders them for its own driver.

  /** Run a batch of statements (DDL); may contain several statements. */
  exec(sql: string): Promise<void>;
  /** Run a statement and discard any result set. */
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** Run a statement and return every row. */
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Run a statement and return its first row, or `undefined`. */
  get<T>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  /** Insert one row and return the id the database assigned to it. */
  insert(sql: string, params?: SqlParam[]): Promise<number>;
  /** Close the underlying connection / pool. */
  close(): Promise<void>;

  /** Spelling of the nth (1-based) bind parameter. */
  placeholder(index: number): string;

  // ── Schema fragments (see db-schema.ts) ────────────────────────────────

  /**
   * Type + key clause for the `claims` insertion cursor.
   *
   * `claims` already takes its primary key from {@link claimsKeyClause}, so
   * this must NOT declare one of its own (Postgres rejects two). Uniqueness of
   * `id` comes from an index instead.
   */
  claimsIdType: string;
  /** Type + key clause for the standalone `app_submissions` id. */
  submissionIdType: string;
  /** Table-level key clause enforcing one row per (wallet, credential_type). */
  claimsKeyClause: string;
  /** Column type for the wide numeric columns (ledger numbers, timestamps). */
  intType: string;
  /** Column type for 0/1 flags. */
  flagType: string;
  /** Column type for stored timestamps. */
  timestampType: string;
  /** Type + default for the auto-stamped `created_at` column. */
  createdAtType: string;
  /** Current-timestamp expression used when stamping `reviewed_at`. */
  nowExpr: string;
  /** `OR IGNORE` for inserts, or empty when the dialect uses ON CONFLICT. */
  insertIgnorePrefix: string;
  /** `ON CONFLICT (...) DO NOTHING` for the cursor seed; empty when ignored above. */
  conflictDoNothing: string;
  /** Case used to reference the inserted row in an upsert's DO UPDATE SET. */
  excludedRef: string;
  /** Narrow an aggregate to a JS number (Postgres needs an explicit cast). */
  castCount(expr: string): string;
  /** Extra claim indexes this dialect needs beyond the shared ones. */
  extraClaimIndexes: string[];

  // ── Legacy upgrade ─────────────────────────────────────────────────────

  /**
   * Bring a `claims` table created before the `id` insertion cursor up to the
   * current shape, idempotently. Runs between the table DDL and the index DDL,
   * because the shared indexes reference `claims.id`.
   */
  migrateClaimsId(): Promise<void>;
}

/**
 * The part of a dialect that parameter binding needs: which driver we are
 * talking to, and how it spells the nth bind parameter.
 */
export type PlaceholderStyle = Pick<SqlDialect, "name" | "placeholder">;

/**
 * Bind parameters into a SQL string written with `?` placeholders.
 *
 * The shared layer writes `?` and passes values; the adapter rewrites them
 * positionally for its driver (`?` stays `?` on SQLite, becomes `$1`, `$2`, …
 * on Postgres). The `?`/`?:` JS operators never appear in our SQL, so a plain
 * scan is unambiguous — and a mismatched count is a bug worth failing loudly on
 * rather than silently dropping a bind.
 */
export function bindSql(
  style: PlaceholderStyle,
  sql: string,
  params: SqlParam[] = [],
): string {
  let bound = 0;
  const text = sql.replace(/\?/g, () => {
    bound += 1;
    return style.placeholder(bound);
  });
  if (bound !== params.length) {
    throw new Error(
      `${style.name}: SQL has ${bound} placeholder(s) but ${params.length} value(s) were bound`,
    );
  }
  return text;
}
