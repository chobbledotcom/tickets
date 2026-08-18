/**
 * Request-scoped background work queue
 *
 * Collects promises (webhooks, ntfy, etc.) that fire during a request
 * and must complete before the edge runtime tears down the request context.
 * Bunny Edge Scripting rejects fetch calls after the response is sent
 * with "api limit reached: fetch", so we flush all pending work in
 * handleRequest's finally block.
 */

import { range } from "#fp";
import { createScope, type ScopeRunner } from "#shared/request-scoped.ts";

const pendingWork = createScope<Promise<unknown>[]>();

/**
 * Run a function within a pending-work scope. Whatever `fn` resolves to, the
 * queue is drained once more on the way out: an error logged *after* the
 * request's own flush (e.g. while the response is finalised) still queues
 * work, and work that outlived its request would complete during whatever
 * runs next — on Bunny that's a killed fetch, in tests a sanitizer failure
 * in an unrelated test.
 */
export const runWithPendingWork: ScopeRunner = (fn) =>
  pendingWork.run([], async () => {
    try {
      return await fn();
    } finally {
      await flushPendingWork();
    }
  });

/** True when running inside a `runWithPendingWork` scope (i.e. a request). */
export const hasPendingWorkScope = (): boolean =>
  pendingWork.current() !== undefined;

/** Queue a promise that must complete before the response is sent */
export const addPendingWork = (p: Promise<unknown>): void => {
  pendingWork.current()?.push(p);
};

/** Each flush round settles everything queued so far, so needing this many
 * rounds means something queues fresh work forever rather than finishing. */
const MAX_FLUSH_ROUNDS = 1_000;

/** Await all queued work. Call before returning the response. Repeats until
 * the queue stays empty: work already running can queue more (a background job
 * that fails queues its error's activity-log write), and a single pass would
 * discard those late arrivals unawaited. */
export const flushPendingWork = async (): Promise<void> => {
  const pending = pendingWork.current();
  if (!pending) return;
  for (const _round of range(0, MAX_FLUSH_ROUNDS)) {
    if (pending.length === 0) return;
    await Promise.allSettled(pending.splice(0));
  }
  throw new Error("Pending work kept queueing more work instead of finishing");
};
