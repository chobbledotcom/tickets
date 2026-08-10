import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type PendingListing,
  planPush,
  type PushAction,
  type PushPlanInput,
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

describe("planPush — local (no calendar call) rules", () => {
  test("clears dateless, never-pushed rows locally in a single batch", () => {
    const { actions } = plan({
      pending: [
        pending({ dated: false, everPushed: false, id: 1 }),
        pending({ dated: false, everPushed: false, id: 2 }),
      ],
    });
    const clears = ofKind(actions, "clearLocal");
    expect(clears).toHaveLength(1);
    expect(clears[0]!.ids).toEqual([1, 2]);
  });

  test("emits no clearLocal action when there is nothing to clear", () => {
    const { actions } = plan({ pending: [pending({ id: 1 })] });
    expect(ofKind(actions, "clearLocal")).toHaveLength(0);
  });

  test("queues a delete for a once-pushed row that lost its date", () => {
    const { actions } = plan({
      pending: [pending({ dated: false, everPushed: true, id: 7, pending: 3 })],
    });
    expect(ofKind(actions, "queueDelete")).toEqual([
      { kind: "queueDelete", listingId: 7, pending: 3 },
    ]);
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
  test("splits a tight budget so neither deletes nor pushes are starved", () => {
    // budget 8, no refresh: both sides have plenty of work, so each gets some.
    const deletes = Array.from(
      { length: 20 },
      (_, i) => queued({ queueId: i }),
    );
    const listings = Array.from(
      { length: 20 },
      (_, i) => pending({ id: 100 + i }),
    );
    const { actions } = plan({ budget: 8, deletes, pending: listings });
    expect(ofKind(actions, "deleteRemote").length).toBeGreaterThan(0);
    expect(ofKind(actions, "put").length).toBeGreaterThan(0);
    expect(
      ofKind(actions, "deleteRemote").length + ofKind(actions, "put").length,
    ).toBe(8);
  });

  test("gives the whole budget to pushes when there is nothing to delete", () => {
    const listings = Array.from({ length: 20 }, (_, i) => pending({ id: i }));
    const { actions } = plan({ budget: 6, pending: listings });
    expect(ofKind(actions, "put")).toHaveLength(6);
  });

  test("reports more work only when due work was left unfinished", () => {
    const listings = Array.from({ length: 20 }, (_, i) => pending({ id: i }));
    expect(plan({ budget: 4, pending: listings }).moreWork).toBe(true);
    expect(plan({ budget: 4, pending: listings.slice(0, 3) }).moreWork).toBe(
      false,
    );
  });
});

describe("planPush — fair retry rotation", () => {
  test("a steady stream of fresh work never starves an old failed row", () => {
    // budget 4, one push slot in four is reserved for the oldest retry.
    const fresh = Array.from({ length: 10 }, (_, i) => pending({ id: i }));
    const stuck = pending({ attemptAt: NOW - RETRY_MS, id: 999, pending: 5 });
    const { actions } = plan({ budget: 4, pending: [stuck, ...fresh] });
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
});

describe("planPush — refresh sweep", () => {
  test("spends leftover budget re-sending the stalest mirrored listings", () => {
    const { actions } = plan({
      budget: 8,
      pending: [pending({ id: 1 })],
      refresh: [{ id: 10 }, { id: 11 }, { id: 12 }],
    });
    expect(ofKind(actions, "refresh").map((a) => a.listingId)).toEqual([
      10,
      11,
      12,
    ]);
  });

  test("keeps a reserved refresh slot even under a full delete/push backlog", () => {
    const deletes = Array.from(
      { length: 20 },
      (_, i) => queued({ queueId: i }),
    );
    const listings = Array.from(
      { length: 20 },
      (_, i) => pending({ id: 100 + i }),
    );
    const { actions } = plan({
      budget: 8,
      deletes,
      pending: listings,
      refresh: [{ id: 500 }, { id: 501 }],
    });
    // The backlog cannot consume the whole budget: refresh still gets a turn.
    expect(ofKind(actions, "refresh").length).toBeGreaterThan(0);
  });

  test("does no refresh when there are no already-mirrored listings", () => {
    const { actions } = plan({ pending: [pending({ id: 1 })] });
    expect(ofKind(actions, "refresh")).toHaveLength(0);
  });
});
