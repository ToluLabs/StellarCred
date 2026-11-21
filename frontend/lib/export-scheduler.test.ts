// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore, setSharedStoreForTesting } from "./shared-store";
import {
  enqueueExportJob,
  dequeueNextJob,
  listQueuedJobs,
  cancelQueuedJob,
  __resetSchedulerForTesting,
  type QueueEntry,
} from "./export-scheduler";

function makeEntry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    jobId: `job-${Math.random().toString(36).slice(2)}`,
    recordId: `rec-${Math.random().toString(36).slice(2)}`,
    issuer: "GISSUER",
    cost: 1,
    enqueuedAt: Date.now(),
    ...overrides,
  };
}

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
  setSharedStoreForTesting(store);
  __resetSchedulerForTesting();
});

afterEach(() => {
  setSharedStoreForTesting(null);
});

describe("enqueueExportJob", () => {
  it("adds one entry to an empty queue", async () => {
    const entry = makeEntry({ cost: 5 });
    await enqueueExportJob(entry);
    const jobs = await listQueuedJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe(entry.jobId);
  });

  it("queue is sorted by cost ASC after multiple enqueues", async () => {
    await enqueueExportJob(makeEntry({ jobId: "j-10", cost: 10 }));
    await enqueueExportJob(makeEntry({ jobId: "j-1", cost: 1 }));
    await enqueueExportJob(makeEntry({ jobId: "j-5", cost: 5 }));

    const jobs = await listQueuedJobs();
    expect(jobs.map((j) => j.cost)).toEqual([1, 5, 10]);
  });
});

describe("dequeueNextJob", () => {
  it("returns null on an empty queue", async () => {
    const result = await dequeueNextJob();
    expect(result).toBeNull();
  });

  it("returns the lowest-cost entry and removes it from the queue", async () => {
    await enqueueExportJob(makeEntry({ jobId: "j-5", cost: 5 }));
    await enqueueExportJob(makeEntry({ jobId: "j-2", cost: 2 }));

    const first = await dequeueNextJob();
    expect(first?.cost).toBe(2);
    expect(first?.jobId).toBe("j-2");

    const second = await dequeueNextJob();
    expect(second?.cost).toBe(5);
    expect(second?.jobId).toBe("j-5");

    // Queue is now empty
    expect(await dequeueNextJob()).toBeNull();
  });

  it("dequeue order matches cost ASC across three entries", async () => {
    await enqueueExportJob(makeEntry({ jobId: "j-a", cost: 100 }));
    await enqueueExportJob(makeEntry({ jobId: "j-b", cost: 1 }));
    await enqueueExportJob(makeEntry({ jobId: "j-c", cost: 50 }));

    const order: number[] = [];
    for (let i = 0; i < 3; i++) {
      const entry = await dequeueNextJob();
      order.push(entry!.cost);
    }
    expect(order).toEqual([1, 50, 100]);
  });
});

describe("cancelQueuedJob", () => {
  it("removes the entry with the matching jobId", async () => {
    const a = makeEntry({ jobId: "cancel-a", cost: 1 });
    const b = makeEntry({ jobId: "cancel-b", cost: 2 });
    await enqueueExportJob(a);
    await enqueueExportJob(b);

    const removed = await cancelQueuedJob("cancel-a");
    expect(removed).toBe(true);

    const remaining = await listQueuedJobs();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].jobId).toBe("cancel-b");
  });

  it("returns false for a jobId not in the queue", async () => {
    const result = await cancelQueuedJob("nonexistent-id");
    expect(result).toBe(false);
  });

  it("returns true when an entry is successfully removed", async () => {
    const entry = makeEntry({ jobId: "cancel-c" });
    await enqueueExportJob(entry);
    const result = await cancelQueuedJob("cancel-c");
    expect(result).toBe(true);
  });
});

describe("listQueuedJobs", () => {
  it("returns an empty array on a fresh store", async () => {
    const jobs = await listQueuedJobs();
    expect(jobs).toEqual([]);
  });

  it("never mutates the queue — two sequential calls return the same entries", async () => {
    await enqueueExportJob(makeEntry({ jobId: "j-stable", cost: 7 }));
    const first = await listQueuedJobs();
    const second = await listQueuedJobs();
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].jobId).toBe(second[0].jobId);
  });

  it("returns a copy — mutating the result does not affect the queue", async () => {
    await enqueueExportJob(makeEntry({ jobId: "j-copy", cost: 3 }));
    const jobs = await listQueuedJobs();
    // Mutate the returned array
    jobs.pop();
    // Queue still has 1 entry
    const fresh = await listQueuedJobs();
    expect(fresh).toHaveLength(1);
  });
});

describe("queue persistence in shared store", () => {
  it("reading the raw store key parses correctly after enqueue", async () => {
    const entry = makeEntry({ jobId: "j-persist", cost: 42 });
    await enqueueExportJob(entry);

    const raw = await store.get("export:queue");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as QueueEntry[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].jobId).toBe("j-persist");
    expect(parsed[0].cost).toBe(42);
  });
});
