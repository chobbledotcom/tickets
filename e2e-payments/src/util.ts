/** Small process/timing helpers shared across the harness. */

import type { ChildProcess } from "node:child_process";

/** Resolve after `ms` milliseconds — for polling loops and retry backoff. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

/** The allowance for one health probe while something starts up. */
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

/**
 * The abort signal for one health probe inside a loop that ends at `deadline`.
 * A probe never outlives the deadline it is waiting for, so a startup bounded
 * at (say) 60s cannot run to 65s because its last probe hung. With no time
 * left the signal aborts at once, which is the honest answer.
 */
export const probeSignal = (deadline: number): AbortSignal =>
  AbortSignal.timeout(
    Math.max(0, Math.min(HEALTH_PROBE_TIMEOUT_MS, deadline - Date.now())),
  );

/** Poll until `check` returns a value or the deadline passes. */
export const pollUntil = async <Value>(
  timeoutMs: number,
  check: () => Promise<Value | null>,
): Promise<Value | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== null) return value;
    await sleep(1_000);
  }
  return null;
};

/**
 * Graceful child-process shutdown: resolve on exit, SIGTERM, then hard SIGKILL
 * after a grace period so a stuck child can never hang teardown.
 */
export const stopChild =
  (child: ChildProcess, graceMs = 3_000): (() => Promise<void>) =>
  () =>
    new Promise<void>((resolveP) => {
      child.once("exit", () => resolveP());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        resolveP();
      }, graceMs);
    });
