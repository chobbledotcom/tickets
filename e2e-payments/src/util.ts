/** Small process/timing helpers shared across the harness. */

import type { ChildProcess } from "node:child_process";

/** Resolve after `ms` milliseconds — for polling loops and retry backoff. */
export const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

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
