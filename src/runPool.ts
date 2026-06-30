/**
 * Generic in-flight-capped worker pool.
 *
 * Used by:
 *   - runBatchCommands (ctx_batch_execute parallel branch)
 *   - runBatchFetch    (ctx_fetch_and_index batch path)
 *
 * Returns Promise.allSettled-style results so one job's throw cannot
 * strand siblings. Caller maps fulfilled/rejected per index. Output
 * order is preserved by input index (not completion order).
 *
 * Designed to be the SINGLE concurrency primitive for the project —
 * all "run N independent operations with at most M in flight" needs
 * route here. Avoids the worker-pool copy-paste flagged in the
 * concurrency PRD architectural review (finding G).
 *
 * Concurrency safety note: Node.js is single-threaded; `nextIdx++` is
 * atomic within one turn of the event loop (no preemption between the
 * read and write). Workers only yield at the `await` inside the loop
 * body — by that point `nextIdx` has already been incremented and the
 * slot is exclusively owned by this worker. This pattern is therefore
 * race-free in Node.js despite looking like a TOCTOU issue in a
 * multi-threaded context.
 */

import { cpus } from "node:os";

export interface PoolJob<T> {
  run(): Promise<T>;
}

/** Hard upper bound on batch size to prevent unbounded memory growth. */
export const MAX_BATCH_SIZE = 10_000;

export interface RunPoolOptions {
  /** Hard concurrency cap (1-N). Auto-clamped to job count. */
  concurrency: number;
  /** Optional: also clamp by `os.cpus().length` (memory-pressure safety). Default false. */
  capByCpuCount?: boolean;
  /** Optional: per-settled callback (e.g. for progress reporting / metrics). */
  onSettled?: (idx: number, result: PromiseSettledResult<unknown>) => void;
  /**
   * Optional: AbortSignal for cooperative cancellation. When aborted, workers
   * stop claiming new jobs and pending slots are filled with rejection results
   * (reason: the signal's abort reason). In-flight jobs are NOT interrupted —
   * callers must propagate the signal into job.run() themselves if needed.
   */
  signal?: AbortSignal;
  /**
   * Hard cap on batch size (default: MAX_BATCH_SIZE = 10 000). Exceeding this
   * throws synchronously so callers can split large inputs into smaller batches
   * instead of silently consuming unbounded heap.
   */
  maxBatchSize?: number;
}

export interface RunPoolResult<T> {
  /** Per-index settled result, ordered by input index. */
  settled: PromiseSettledResult<T>[];
  /** Concurrency actually used after all caps applied. */
  effectiveConcurrency: number;
  /** True when effectiveConcurrency < requested concurrency. */
  capped: boolean;
  /** True when execution was cancelled via AbortSignal before all jobs ran. */
  aborted: boolean;
}

export async function runPool<T>(
  jobs: PoolJob<T>[],
  opts: RunPoolOptions,
): Promise<RunPoolResult<T>> {
  const {
    concurrency,
    capByCpuCount = false,
    onSettled,
    signal,
    maxBatchSize = MAX_BATCH_SIZE,
  } = opts;

  // Backpressure guard: reject oversized batches before allocating.
  if (jobs.length > maxBatchSize) {
    throw new RangeError(
      `runPool: batch size ${jobs.length} exceeds maxBatchSize ${maxBatchSize}. ` +
        `Split the input or raise maxBatchSize explicitly.`,
    );
  }

  if (jobs.length === 0) {
    return { settled: [], effectiveConcurrency: 0, capped: false, aborted: false };
  }

  // Check for pre-aborted signal before doing any work.
  if (signal?.aborted) {
    const reason = signal.reason ?? new DOMException("AbortError", "AbortError");
    const settled: PromiseSettledResult<T>[] = jobs.map(() => ({
      status: "rejected" as const,
      reason,
    }));
    return { settled, effectiveConcurrency: 0, capped: false, aborted: true };
  }

  const requested = Math.max(1, concurrency);
  const cpuCap = capByCpuCount ? Math.max(1, cpus().length) : requested;
  const effectiveConcurrency = Math.min(requested, cpuCap, jobs.length);
  const capped = effectiveConcurrency < requested;

  const settled: PromiseSettledResult<T>[] = new Array(jobs.length);
  let nextIdx = 0;
  let aborted = false;

  async function worker(): Promise<void> {
    while (true) {
      // Check signal before claiming the next slot (cooperative cancellation).
      if (signal?.aborted) {
        aborted = true;
        // Fill all unclaimed slots with abort-rejection results.
        for (let i = nextIdx; i < jobs.length; i++) {
          if (settled[i] === undefined) {
            const reason = signal.reason ?? new DOMException("AbortError", "AbortError");
            settled[i] = { status: "rejected", reason };
            onSettled?.(i, settled[i]);
          }
        }
        // Mark nextIdx as exhausted so other workers also stop.
        nextIdx = jobs.length;
        return;
      }

      // nextIdx++ is atomic within a single JS turn — no TOCTOU risk
      // (see module-level safety note above).
      const idx = nextIdx++;
      if (idx >= jobs.length) return;

      try {
        const value = await jobs[idx].run();
        settled[idx] = { status: "fulfilled", value };
      } catch (err) {
        settled[idx] = { status: "rejected", reason: err };
      }
      onSettled?.(idx, settled[idx]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < effectiveConcurrency; w++) workers.push(worker());
  // allSettled defends against any promise rejection escaping a worker
  // (the worker already swallows its own errors, but this is belt-and-braces).
  await Promise.allSettled(workers);

  return { settled, effectiveConcurrency, capped, aborted };
}
