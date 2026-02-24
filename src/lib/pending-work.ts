/**
 * Request-scoped background work queue
 *
 * Collects promises (webhooks, ntfy, etc.) that fire during a request
 * and must complete before the edge runtime tears down the request context.
 * Bunny Edge Scripting rejects fetch calls after the response is sent
 * with "api limit reached: fetch", so we flush all pending work in
 * handleRequest's finally block.
 */

import { AsyncLocalStorage } from "node:async_hooks";

const pendingWork = new AsyncLocalStorage<Promise<void>[]>();

/** Run a function within a pending-work scope */
export const runWithPendingWork = <T>(fn: () => T): T =>
  pendingWork.run([], fn);

/** Queue a promise that must complete before the response is sent */
export const addPendingWork = (p: Promise<void>): void => {
  const pending = pendingWork.getStore();
  if (pending) pending.push(p);
};

/** Await all queued work. Call before returning the response. */
export const flushPendingWork = async (): Promise<void> => {
  const pending = pendingWork.getStore();
  if (!pending || pending.length === 0) return;
  await Promise.allSettled(pending);
  pending.length = 0;
};
