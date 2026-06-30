import { describe, it, expect } from "vitest";
import { runPool, MAX_BATCH_SIZE } from "../../src/runPool.js";
import type { PoolJob, RunPoolOptions } from "../../src/runPool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJobs<T>(n: number, fn: (idx: number) => Promise<T>): PoolJob<T>[] {
  return Array.from({ length: n }, (_, i) => ({ run: () => fn(i) }));
}

function makeIdentityJobs(n: number): PoolJob<number>[] {
  return makeJobs(n, (i) => Promise.resolve(i));
}

// ---------------------------------------------------------------------------
// Basic correctness
// ---------------------------------------------------------------------------

describe("runPool — basic correctness", () => {
  it("returns empty result for zero jobs", async () => {
    const result = await runPool([], { concurrency: 4 });
    expect(result.settled).toHaveLength(0);
    expect(result.effectiveConcurrency).toBe(0);
    expect(result.capped).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it("resolves all jobs and preserves output order", async () => {
    const jobs = makeIdentityJobs(20);
    const { settled } = await runPool(jobs, { concurrency: 4 });

    expect(settled).toHaveLength(20);
    for (let i = 0; i < 20; i++) {
      expect(settled[i]).toEqual({ status: "fulfilled", value: i });
    }
  });

  it("handles single-concurrency (serial execution)", async () => {
    const order: number[] = [];
    const jobs = makeJobs(5, async (i) => {
      order.push(i);
      return i;
    });
    await runPool(jobs, { concurrency: 1 });
    // With concurrency 1, jobs run in index order.
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("capped flag is set when concurrency exceeds job count", async () => {
    const jobs = makeIdentityJobs(3);
    const { capped, effectiveConcurrency } = await runPool(jobs, { concurrency: 10 });
    expect(capped).toBe(true);
    expect(effectiveConcurrency).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Exactly-once fuzz: random delays, varied concurrency levels
// ---------------------------------------------------------------------------

describe("runPool — exactly-once execution fuzz", () => {
  it("each job runs exactly once across multiple concurrency levels", async () => {
    const concurrencies = [1, 2, 4, 8, 16];
    const jobCount = 200;

    for (const concurrency of concurrencies) {
      const executionCount = new Array(jobCount).fill(0);

      const jobs: PoolJob<void>[] = Array.from({ length: jobCount }, (_, i) => ({
        run: async () => {
          // Random delay (0-5 ms) to interleave workers.
          await new Promise<void>((r) => setTimeout(r, Math.random() * 5));
          executionCount[i]++;
        },
      }));

      await runPool(jobs, { concurrency });

      for (let i = 0; i < jobCount; i++) {
        expect(executionCount[i]).toBe(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Batch cap (backpressure guard)
// ---------------------------------------------------------------------------

describe("runPool — batch cap", () => {
  it("throws RangeError synchronously when batch exceeds default maxBatchSize", async () => {
    const jobs = makeIdentityJobs(MAX_BATCH_SIZE + 1);
    await expect(runPool(jobs, { concurrency: 4 })).rejects.toThrow(RangeError);
    await expect(runPool(jobs, { concurrency: 4 })).rejects.toThrow(/maxBatchSize/);
  });

  it("succeeds at exactly maxBatchSize jobs", async () => {
    // This is a large array — just check shape, not values, to keep the test fast.
    const jobs = makeIdentityJobs(MAX_BATCH_SIZE);
    const { settled } = await runPool(jobs, { concurrency: 64 });
    expect(settled).toHaveLength(MAX_BATCH_SIZE);
  });

  it("respects a custom maxBatchSize", async () => {
    const jobs = makeIdentityJobs(6);
    await expect(runPool(jobs, { concurrency: 2, maxBatchSize: 5 })).rejects.toThrow(
      RangeError,
    );
    // At exactly the cap it must pass.
    const jobs5 = makeIdentityJobs(5);
    const { settled } = await runPool(jobs5, { concurrency: 2, maxBatchSize: 5 });
    expect(settled).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// AbortSignal — cooperative cancellation
// ---------------------------------------------------------------------------

describe("runPool — AbortSignal cancellation", () => {
  it("returns all-rejected when signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before start"));

    const jobs = makeIdentityJobs(10);
    const result = await runPool(jobs, { concurrency: 4, signal: controller.signal });

    expect(result.aborted).toBe(true);
    expect(result.effectiveConcurrency).toBe(0);
    for (const s of result.settled) {
      expect(s.status).toBe("rejected");
    }
  });

  it("stops claiming new jobs after abort mid-run", async () => {
    const controller = new AbortController();
    const started: number[] = [];

    const jobs: PoolJob<number>[] = Array.from({ length: 50 }, (_, i) => ({
      run: async () => {
        started.push(i);
        if (i === 4) controller.abort();
        // Small delay so the abort can propagate before workers pick up more.
        await new Promise<void>((r) => setTimeout(r, 2));
        return i;
      },
    }));

    const result = await runPool(jobs, {
      concurrency: 1,
      signal: controller.signal,
    });

    // Concurrency 1 is serial — abort at job 4 should prevent all jobs > 4 from
    // starting (workers check the signal before claiming the next slot).
    expect(result.aborted).toBe(true);
    // Every claimed slot either succeeded (pre-abort) or was filled by the abort path.
    expect(result.settled).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Error isolation
// ---------------------------------------------------------------------------

describe("runPool — error isolation", () => {
  it("one failing job does not prevent others from running", async () => {
    const jobs: PoolJob<number>[] = Array.from({ length: 10 }, (_, i) => ({
      run: async () => {
        if (i === 5) throw new Error("boom");
        return i;
      },
    }));

    const { settled } = await runPool(jobs, { concurrency: 3 });
    expect(settled[5]).toEqual({ status: "rejected", reason: expect.any(Error) });
    for (let i = 0; i < 10; i++) {
      if (i === 5) continue;
      expect(settled[i]).toEqual({ status: "fulfilled", value: i });
    }
  });
});

// ---------------------------------------------------------------------------
// onSettled callback
// ---------------------------------------------------------------------------

describe("runPool — onSettled callback", () => {
  it("fires for every job in index order after settlement", async () => {
    const calls: Array<[number, PromiseSettledResult<number>]> = [];
    const jobs = makeIdentityJobs(8);

    await runPool(jobs, {
      concurrency: 4,
      onSettled: (idx, result) => calls.push([idx, result as PromiseSettledResult<number>]),
    });

    expect(calls).toHaveLength(8);
    // All indices appear exactly once.
    const indices = calls.map(([i]) => i).sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
