import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PendingListing,
  type PushAction,
  type PushPlanInput,
  planPush,
  type QueuedDelete,
} from "#shared/caldav/push-plan.ts";

const NOW = 1_000_000;
const RETRY_MS = 300_000;

const pending = (
  over: Partial<PendingListing> & { id: number },
): PendingListing => ({
  attemptAt: null,
  dated: true,
  everPushed: false,
  pending: 1,
  ...over,
});

const queued = (
  over: Partial<QueuedDelete> & { queueId: number },
): QueuedDelete => ({
  attemptAt: null,
  href: `https://cal.example/${over.queueId}.ics`,
  listingId: over.queueId,
  listingStillDated: false,
  ...over,
});

const plan = (over: Partial<PushPlanInput>): ReturnType<typeof planPush> =>
  planPush({
    budget: 8,
    deletes: [],
    nowMs: NOW,
    pending: [],
    refresh: [],
    retryIntervalMs: RETRY_MS,
    ...over,
  });

const kinds = (actions: readonly PushAction[]): string[] =>
  actions.map((action) => action.kind);

const ofKind = <K extends PushAction["kind"]>(
  actions: readonly PushAction[],
  kind: K,
): Extract<PushAction, { kind: K }>[] =>
  actions.filter((a): a is Extract<PushAction, { kind: K }> => a.kind === kind);

const manyDeletes = (n: number) =>
  Array.from({ length: n }, (_, i) => queued({ queueId: i }));

const manyPending = (n: number, base = 0) =>
  Array.from({ length: n }, (_, i) => pending({ id: base + i }));

const dateless = (id: number): PendingListing =>
  pending({ dated: false, everPushed: false, id });

// Plan these rows and return the single clearLocal batch's rows — the local
// clears always collapse into one batch action, so exactly one is expected.
const clearBatchRows = (rows: readonly PendingListing[]) => {
  const clears = ofKind(plan({ pending: rows }).actions, "clearLocal");
  expect(clears).toHaveLength(1);
  return clears[0]!.rows;
};

describe("planPush — local (no calendar call) rules", () => {
  test("collapses dateless, never-pushed rows into one revision-guarded batch", () => {
    // Each row carries its revision so a late edit that lands between planning
    // and applying is guarded against.
    expect(clearBatchRows([dateless(1), dateless(2)])).toEqual([
      { id: 1, pending: 1 },
      { id: 2, pending: 1 },
    ]);
  });

  test("clears even a single dateless never-pushed row", () => {
    expect(clearBatchRows([dateless(1)])).toEqual([{ id: 1, pending: 1 }]);
  });

  test("never queues a remote delete for a row it only clears locally", () => {
    // Nothing remote exists for a never-pushed row, so a local clear must not
    // also queue a delete.
    const { actions } = plan({ pending: [dateless(1)] });
    expect(ofKind(actions, "queueDelete")).toHaveLength(0);
  });

  test("emits no clearLocal action when there is nothing to clear", () => {
    const { actions } = plan({ pending: [pending({ id: 1 })] });
    expect(ofKind(actions, "clearLocal")).toHaveLength(0);
  });

  test("queues a delete for a once-pushed row that lost its date", () => {
    const { moreWork, actions } = plan({
      pending: [pending({ dated: false, everPushed: true, id: 7, pending: 3 })],
    });
    expect(ofKind(actions, "queueDelete")).toEqual([
      { kind: "queueDelete", listingId: 7, pending: 3 },
    ]);
    // Newly queued delete work must trigger a quick re-wake so it drains this
    // cycle rather than waiting for the next scheduled pass.
    expect(moreWork).toBe(true);
  });

  test("drops a queued delete whose listing is dated again, with no call", () => {
    const { actions } = plan({
      deletes: [queued({ listingStillDated: true, queueId: 9 })],
    });
    expect(ofKind(actions, "dropStaleDelete")).toEqual([
      { kind: "dropStaleDelete", queueId: 9 },
    ]);
    expect(ofKind(actions, "deleteRemote")).toHaveLength(0);
  });
});

describe("planPush — external work and ordering", () => {
  test("sends a dated pending listing as a put", () => {
    const { actions } = plan({ pending: [pending({ id: 4, pending: 2 })] });
    expect(ofKind(actions, "put")).toEqual([
      { kind: "put", listingId: 4, pending: 2 },
    ]);
  });

  test("drains the delete queue before pushing pending listings", () => {
    const { actions } = plan({
      deletes: [queued({ queueId: 1 })],
      pending: [pending({ id: 2 })],
    });
    const order = kinds(actions);
    expect(order.indexOf("deleteRemote")).toBeLessThan(order.indexOf("put"));
  });

  test("counts a 404-safe DELETE against the budget by its href", () => {
    const { actions } = plan({
      deletes: [queued({ href: "https://cal.example/x.ics", queueId: 5 })],
    });
    expect(ofKind(actions, "deleteRemote")).toEqual([
      { href: "https://cal.example/x.ics", kind: "deleteRemote", queueId: 5 },
    ]);
  });
});

describe("planPush — budget sharing", () => {
  test("splits a tight budget evenly when both sides have plenty of work", () => {
    // budget 8, no refresh: two equal backlogs split down the middle, 4 each.
    const { actions } = plan({
      budget: 8,
      deletes: manyDeletes(20),
      pending: manyPending(20, 100),
    });
    expect(ofKind(actions, "deleteRemote")).toHaveLength(4);
    expect(ofKind(actions, "put")).toHaveLength(4);
  });

  test("gives the whole budget to pushes when there is nothing to delete", () => {
    const { actions } = plan({ budget: 6, pending: manyPending(20) });
    expect(ofKind(actions, "put")).toHaveLength(6);
  });

  test("reports more work only when due work was left unfinished", () => {
    const listings = manyPending(20);
    expect(plan({ budget: 4, pending: listings }).moreWork).toBe(true);
    expect(plan({ budget: 4, pending: listings.slice(0, 3) }).moreWork).toBe(
      false,
    );
  });

  test("reports more work when even a single due item is left over", () => {
    // budget 4, five due pushes: four go out, one is deferred → wake again.
    const { actions, moreWork } = plan({ budget: 4, pending: manyPending(5) });
    expect(ofKind(actions, "put")).toHaveLength(4);
    expect(moreWork).toBe(true);
  });
});

describe("planPush — fair retry rotation", () => {
  test("a steady stream of fresh work never starves an old failed row", () => {
    // budget 4, one push slot in four is reserved for the oldest retry.
    const stuck = pending({ attemptAt: NOW - RETRY_MS, id: 999, pending: 5 });
    const { actions } = plan({
      budget: 4,
      pending: [stuck, ...manyPending(10)],
    });
    const puts = ofKind(actions, "put");
    expect(puts).toHaveLength(4);
    expect(puts.some((p) => p.listingId === 999)).toBe(true);
  });

  test("leaves a recently-failed row cooling off, recorded as a skip", () => {
    const cooling = pending({ attemptAt: NOW - 1, id: 3 });
    const { actions } = plan({ pending: [cooling] });
    expect(ofKind(actions, "put")).toHaveLength(0);
    expect(ofKind(actions, "skip")).toEqual([
      { kind: "skip", reason: "waiting-retry" },
    ]);
  });

  test("retries a failed row once its cool-off has fully elapsed", () => {
    const due = pending({ attemptAt: NOW - RETRY_MS, id: 3 });
    const { actions } = plan({ pending: [due] });
    expect(ofKind(actions, "put")).toHaveLength(1);
    expect(ofKind(actions, "skip")).toHaveLength(0);
  });

  test("retries the least-recently-attempted failed row first", () => {
    // Two stuck rows, room for one retry: the older attempt goes first.
    const older = pending({ attemptAt: NOW - RETRY_MS * 3, id: 1 });
    const newer = pending({ attemptAt: NOW - RETRY_MS * 2, id: 2 });
    const { actions } = plan({ budget: 1, pending: [newer, older] });
    expect(ofKind(actions, "put").map((p) => p.listingId)).toEqual([1]);
  });
});

describe("planPush — refresh sweep", () => {
  const fresh = (id: number) => ({ attemptAt: null, id });

  test("spends leftover budget re-sending the stalest mirrored listings", () => {
    const { actions } = plan({
      budget: 8,
      pending: [pending({ id: 1 })],
      refresh: [fresh(10), fresh(11), fresh(12)],
    });
    expect(ofKind(actions, "refresh").map((a) => a.listingId)).toEqual([
      10, 11, 12,
    ]);
  });

  test("keeps its one reserved refresh slot under a full delete/push backlog", () => {
    // budget 8 reserves one slot (8 / 8) for refresh; the rest splits 4/4 into
    // a 3/4 work split once the reserve is taken out, leaving exactly one
    // refresh through — the backlog can never freeze the sweep out.
    const { actions } = plan({
      budget: 8,
      deletes: manyDeletes(20),
      pending: manyPending(20, 100),
      refresh: [fresh(500)],
    });
    expect(ofKind(actions, "refresh").map((a) => a.listingId)).toEqual([500]);
  });

  test("caps the reserve at a budget-eighth even with more stale candidates", () => {
    // budget 16 reserves two slots (16 / 8); three candidates queue, so exactly
    // two refresh this wake and the third waits — the reserve is a floor, not a
    // free-for-all that would eat into delete/push work.
    const { actions } = plan({
      budget: 16,
      deletes: manyDeletes(20),
      pending: manyPending(20, 100),
      refresh: [fresh(500), fresh(501), fresh(502)],
    });
    expect(ofKind(actions, "refresh")).toHaveLength(2);
  });

  test("skips a refresh candidate that failed too recently to retry", () => {
    const { actions } = plan({
      budget: 8,
      refresh: [{ attemptAt: NOW - 1, id: 10 }, fresh(11)],
    });
    // The recently-failed one cools off; the fresh one still refreshes, so a
    // permanently-failing refresh cannot hog the sweep every wake.
    expect(ofKind(actions, "refresh").map((a) => a.listingId)).toEqual([11]);
  });

  test("a stream of fresh refreshes never starves an old failed refresh", () => {
    // budget 4, six ready refreshes (one long-failed): the reserved retry slot
    // pulls the stale failure in even though five fresh candidates queue ahead.
    const stuck = { attemptAt: NOW - RETRY_MS * 4, id: 999 };
    const { actions } = plan({
      budget: 4,
      refresh: [stuck, fresh(1), fresh(2), fresh(3), fresh(4), fresh(5)],
    });
    const refreshed = ofKind(actions, "refresh").map((a) => a.listingId);
    expect(refreshed).toHaveLength(4);
    expect(refreshed).toContain(999);
  });

  test("does no refresh when there are no already-mirrored listings", () => {
    const { actions } = plan({ pending: [pending({ id: 1 })] });
    expect(ofKind(actions, "refresh")).toHaveLength(0);
  });
});

describe("planPush — retry reservation survives the budget split", () => {
  test("still reserves a delete-retry slot when the split leaves few slots", () => {
    // budget 8, a refresh candidate, both queues busy → the delete side gets
    // only three slots, where a plain quarter would round to zero. A stuck
    // delete must still be picked so it can never be starved forever.
    const stuck = queued({ attemptAt: NOW - RETRY_MS * 4, queueId: 999 });
    const { actions } = plan({
      budget: 8,
      deletes: [stuck, ...manyDeletes(20)],
      pending: manyPending(20, 200),
      refresh: [{ attemptAt: null, id: 500 }],
    });
    expect(ofKind(actions, "deleteRemote").some((d) => d.queueId === 999)).toBe(
      true,
    );
  });
});
