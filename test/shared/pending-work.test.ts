import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  addPendingWork,
  flushPendingWork,
  hasPendingWorkScope,
  runWithPendingWork,
} from "#shared/pending-work.ts";

describe("pending-work", () => {
  test("has a scope inside runWithPendingWork and none outside", async () => {
    expect(hasPendingWorkScope()).toBe(false);
    await runWithPendingWork(async () => {
      expect(hasPendingWorkScope()).toBe(true);
    });
    expect(hasPendingWorkScope()).toBe(false);
  });

  test("flushPendingWork settles queued work inside the scope", async () => {
    let settled = false;
    await runWithPendingWork(async () => {
      addPendingWork(
        (async () => {
          await Promise.resolve();
          settled = true;
        })(),
      );
      await flushPendingWork();
      expect(settled).toBe(true);
    });
  });

  test("work queued after the request's own flush still settles before the scope ends", async () => {
    // An error logged while the response is finalised queues work *after*
    // handleRequest's flush already ran. The scope must drain again on the way
    // out — work outliving its request is a killed fetch on Bunny and a
    // sanitizer failure in an unrelated test here.
    let lateWorkSettled = false;
    await runWithPendingWork(async () => {
      await flushPendingWork(); // the request's own flush
      addPendingWork(
        (async () => {
          // Far more microtask hops than the scope-exit path itself takes, so
          // this only settles in time when the exit actually drains the queue.
          for (let hop = 0; hop < 50; hop++) await Promise.resolve();
          lateWorkSettled = true;
        })(),
      );
    });
    expect(lateWorkSettled).toBe(true);
  });

  test("work queued by work already flushing also settles", async () => {
    // A background job can queue more work while the flush awaits it — a
    // failed job queues its error's activity-log write. A single-pass flush
    // captured the queue once and discarded the late arrival unawaited.
    let chainedSettled = false;
    await runWithPendingWork(async () => {
      addPendingWork(
        (async () => {
          await Promise.resolve();
          addPendingWork(
            (async () => {
              await Promise.resolve();
              chainedSettled = true;
            })(),
          );
        })(),
      );
      await flushPendingWork();
      expect(chainedSettled).toBe(true);
    });
  });

  test("work that queues fresh work forever fails loudly instead of spinning", async () => {
    let keepQueueing = true;
    const queueAgain = (): void => {
      if (keepQueueing) addPendingWork(Promise.resolve().then(queueAgain));
    };
    await runWithPendingWork(async () => {
      queueAgain();
      await expect(flushPendingWork()).rejects.toThrow(
        "Pending work kept queueing more work instead of finishing",
      );
      // Stop the chain and drain its tail so the scope can end cleanly.
      keepQueueing = false;
      await flushPendingWork();
    });
  });

  test("flushPendingWork outside a scope is a no-op", async () => {
    await flushPendingWork(); // nothing to flush and no scope: must not throw
    expect(hasPendingWorkScope()).toBe(false);
  });

  test("addPendingWork outside a scope drops the promise instead of queueing", async () => {
    // Documented behaviour: outside a request there is nothing to flush.
    addPendingWork(Promise.resolve());
    await runWithPendingWork(async () => {
      // The out-of-scope promise did not land in this scope's queue, so the
      // scope resolves without waiting on anything.
      expect(hasPendingWorkScope()).toBe(true);
    });
  });
});
