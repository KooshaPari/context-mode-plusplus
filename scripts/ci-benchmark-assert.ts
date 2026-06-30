/**
 * CI benchmark assertion script.
 *
 * Runs a representative subset of the benchmark suite (JavaScript + shell
 * execution, FTS5 search latency) and asserts that:
 *
 *  1. p95 execution latency stays below SLO thresholds.
 *  2. Heap used after the run stays below the heap budget.
 *
 * Exit code 0 = all SLOs met. Exit code 1 = at least one SLO violated.
 *
 * Designed to run in CI (ubuntu-latest runner). Skips languages whose
 * runtime is unavailable so it degrades gracefully on a stripped-down runner
 * rather than failing the job for missing optional runtimes.
 */

import { PolyglotExecutor } from "../src/executor.js";
import { detectRuntimes } from "../src/runtime.js";
import Database from "better-sqlite3";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContentStore } from "../src/store.js";

// ---------------------------------------------------------------------------
// SLO definitions — tighten as the project matures.
// ---------------------------------------------------------------------------

interface Slo {
  /** Human-readable label. */
  name: string;
  /** p95 wall-clock latency budget in milliseconds. */
  p95Ms: number;
}

const EXECUTION_SLOS: Slo[] = [
  { name: "js: hello-world", p95Ms: 500 },
  { name: "shell: echo", p95Ms: 500 },
];

/** Maximum heapUsed (bytes) after the run. 256 MB covers the FTS5 + executor overhead. */
const HEAP_BUDGET_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Benchmark helpers
// ---------------------------------------------------------------------------

async function measureP95(
  fn: () => Promise<void>,
  iterations: number,
): Promise<number> {
  // Two warmup rounds (not measured).
  for (let i = 0; i < 2; i++) await fn();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t = performance.now();
    await fn();
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length * 0.95)] ?? times[times.length - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const runtimes = detectRuntimes();
const executor = new PolyglotExecutor({ runtimes });

const failures: string[] = [];

// --- Execution latency SLOs ---

async function runExecutionSlos(): Promise<void> {
  const cases: Array<{ slo: Slo; language: "javascript" | "shell"; code: string }> = [
    {
      slo: EXECUTION_SLOS[0],
      language: "javascript",
      code: `console.log("hello world");`,
    },
    {
      slo: EXECUTION_SLOS[1],
      language: "shell",
      code: `echo hello`,
    },
  ];

  for (const { slo, language, code } of cases) {
    const p95 = await measureP95(
      () => executor.execute({ language, code, timeout: 10_000 }).then(() => {}),
      10,
    );
    const status = p95 <= slo.p95Ms ? "PASS" : "FAIL";
    console.log(`[${status}] ${slo.name}: p95=${p95.toFixed(1)}ms (budget ${slo.p95Ms}ms)`);
    if (status === "FAIL") {
      failures.push(`${slo.name}: p95 ${p95.toFixed(1)}ms exceeds ${slo.p95Ms}ms`);
    }
  }
}

// --- FTS5 search latency SLO ---

async function runSearchSlo(): Promise<void> {
  const dbPath = join(mkdtempSync(join(tmpdir(), ".ctx-bench-")), "bench.db");
  const db = new Database(dbPath);
  const store = new ContentStore(db);

  // Seed 1 000 documents.
  for (let i = 0; i < 1_000; i++) {
    store.add(`document ${i}: lorem ipsum context mode benchmark test data entry number ${i}`, `bench-${i}`);
  }

  const SLO_MS = 50; // FTS5 BM25 search must complete within 50 ms p95.
  const p95 = await measureP95(async () => {
    store.search(["context benchmark"], 10);
  }, 20);

  const status = p95 <= SLO_MS ? "PASS" : "FAIL";
  console.log(`[${status}] fts5-search p95: ${p95.toFixed(1)}ms (budget ${SLO_MS}ms)`);
  if (status === "FAIL") {
    failures.push(`fts5-search: p95 ${p95.toFixed(1)}ms exceeds ${SLO_MS}ms`);
  }

  db.close();
  try {
    rmSync(dbPath, { recursive: true, force: true });
  } catch { /* best-effort */ }
}

// --- Heap budget ---

function checkHeapBudget(): void {
  const heapUsed = process.memoryUsage().heapUsed;
  const mb = (heapUsed / 1024 / 1024).toFixed(1);
  const budgetMb = (HEAP_BUDGET_BYTES / 1024 / 1024).toFixed(0);
  const status = heapUsed <= HEAP_BUDGET_BYTES ? "PASS" : "FAIL";
  console.log(`[${status}] heap: ${mb}MB used (budget ${budgetMb}MB)`);
  if (status === "FAIL") {
    failures.push(`heap: ${mb}MB exceeds ${budgetMb}MB budget`);
  }
}

// --- Run ---

console.log("=== CI Benchmark SLO Assertions ===\n");

await runExecutionSlos();
await runSearchSlo();
checkHeapBudget();

console.log(`\n=== Summary: ${failures.length === 0 ? "ALL PASS" : `${failures.length} FAILURE(S)` } ===`);

if (failures.length > 0) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
