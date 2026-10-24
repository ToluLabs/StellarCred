/**
 * Cost-aware priority queue for export jobs (#788).
 *
 * The queue is stored as a JSON array under `export:queue` in the shared KV
 * store, sorted by `cost` ascending (cheapest / smallest jobs run first).
 * All operations use a non-transactional read-modify-write pattern.
 *
 * ## Non-transactional limitation
 *
 * Concurrent `enqueueExportJob` and `dequeueNextJob` calls running in
 * separate Node.js processes (e.g. on multi-instance / serverless deploys
 * with `UpstashRedisStore`) can interleave: two callers may both read the
 * same queue snapshot, both write back a different modified version, and one
 * write will silently overwrite the other. This can result in lost entries or
 * duplicate dequeues. This is acceptable for the current deployment model and
 * is the same limitation documented in `export-concurrency.ts`.
 *
 * Under `MemoryStore` (single Node.js process) this is not a concern because
 * no I/O interleaves synchronous reads and writes on the Node.js event loop.
 *
 * @module export-scheduler
 */

import { getSharedStore } from "./shared-store";

const QUEUE_KEY = "export:queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the export job priority queue. */
export interface QueueEntry {
  /** Unique identifier for this queue entry (typically the export job ID). */
  jobId: string;
  /** The export record ID that this job is processing. */
  recordId: string;
  /** The DID / issuer address that requested the export. */
  issuer: string;
  /**
   * Estimated cost of the job. Lower cost = higher priority.
   * Entries are sorted ascending by cost so the cheapest job dequeues first.
   */
  cost: number;
  /** Unix epoch ms timestamp when the entry was enqueued. */
  enqueuedAt: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function readQueue(): Promise<QueueEntry[]> {
  const store = getSharedStore();
  const raw = await store.get(QUEUE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as QueueEntry[];
  } catch {
    return [];
  }
}

async function writeQueue(entries: QueueEntry[]): Promise<void> {
  const store = getSharedStore();
  await store.set(QUEUE_KEY, JSON.stringify(entries));
}

function sortByCost(entries: QueueEntry[]): QueueEntry[] {
  return [...entries].sort((a, b) => a.cost - b.cost);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Add a job to the queue. The queue is re-sorted by `cost` ASC after each
 * enqueue so `dequeueNextJob` always returns the cheapest entry.
 *
 * **Non-transactional**: see module JSDoc for race conditions on
 * multi-instance deploys.
 */
export async function enqueueExportJob(entry: QueueEntry): Promise<void> {
  const current = await readQueue();
  const updated = sortByCost([...current, entry]);
  await writeQueue(updated);
}

/**
 * Remove and return the lowest-cost entry from the queue.
 * Returns `null` when the queue is empty.
 *
 * **Non-transactional**: see module JSDoc for race conditions on
 * multi-instance deploys.
 */
export async function dequeueNextJob(): Promise<QueueEntry | null> {
  const current = await readQueue();
  if (current.length === 0) return null;

  // Already sorted ascending, so first entry is cheapest.
  const [next, ...rest] = current;
  await writeQueue(rest);
  return next;
}

/**
 * Return a snapshot of all queued jobs, sorted by `cost` ASC.
 * This is a read-only view — it does NOT mutate the queue.
 */
export async function listQueuedJobs(): Promise<QueueEntry[]> {
  const entries = await readQueue();
  // Return a defensive copy; caller must not mutate.
  return sortByCost(entries);
}

/**
 * Remove the queue entry with the given `jobId`.
 *
 * @returns `true` if an entry was found and removed, `false` if `jobId` was
 *          not present in the queue.
 *
 * **Non-transactional**: see module JSDoc for race conditions on
 * multi-instance deploys.
 */
export async function cancelQueuedJob(jobId: string): Promise<boolean> {
  const current = await readQueue();
  const filtered = current.filter((e) => e.jobId !== jobId);
  if (filtered.length === current.length) return false;
  await writeQueue(filtered);
  return true;
}

// ---------------------------------------------------------------------------
// Testing helpers
// ---------------------------------------------------------------------------

/**
 * Delete the queue key from the current store. Callers must also call
 * `setSharedStoreForTesting(new MemoryStore())` for full isolation.
 */
export function __resetSchedulerForTesting(): void {
  const store = getSharedStore();
  store.del(QUEUE_KEY).catch(() => {
    // best-effort — fresh MemoryStore from caller already cleared state
  });
}
