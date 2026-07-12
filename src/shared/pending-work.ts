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
import {
  liveScopeStore,
  runWithScopeLifetime,
} from "#shared/request-scoped.ts";

const pendingWork = new AsyncLocalStorage<Promise<unknown>[]>();

/**
 * Run a function within a pending-work scope. Whatever `fn` resolves to, the
 * queue is drained once more on the way out: an error logged *after* the
 * request's own flush (e.g. while the response is finalised) still queues
 * work, and work that outlived its request would complete during whatever
 * runs next — on Bunny that's a killed fetch, in tests a sanitizer failure
 * in an unrelated test.
 */
export const runWithPendingWork = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithScopeLifetime(pendingWork, [], async () => {
    try {
      return await fn();
    } finally {
      await flushPendingWork();
    }
  });

/** True when running inside a `runWithPendingWork` scope (i.e. a request). */
export const hasPendingWorkScope = (): boolean =>
  liveScopeStore(pendingWork) !== undefined;

/** Queue a promise that must complete before the response is sent */
export const addPendingWork = (p: Promise<unknown>): void => {
  const pending = liveScopeStore(pendingWork);
  if (pending) pending.push(p);
};

/** Await all queued work. Call before returning the response. */
export const flushPendingWork = async (): Promise<void> => {
  const pending = liveScopeStore(pendingWork);
  if (!pending || pending.length === 0) return;
  await Promise.allSettled(pending);
  pending.length = 0;
};
