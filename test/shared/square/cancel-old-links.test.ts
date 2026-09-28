/** The old-Square-link reconciler: only a provider-confirmed cancellation of
 * an unpaid order may delete staged answers, and a local payment always wins
 * over the worker. */

import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  sessionWorkIndex,
  stageCheckoutAnswers,
} from "#db/checkout-pending-answers.ts";
import { execute, queryOne } from "#db/client.ts";
import { squareApi } from "#shared/square/api.ts";
import { runSquareCheckoutCancellation } from "#shared/square/cancel-old-links.ts";
import type { SquareClient } from "#shared/square/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";

/** The client the worker sees this test holding. */
const clients: { current: SquareClient } = {
  current: undefined as unknown as SquareClient,
};

const fakeClient = (
  deleteLink: () => Promise<{ cancelled_order_id: string; id: string }>,
  readOrder: () => Promise<{
    order: { id: string; state: string; tenders?: unknown[] } | null;
  }>,
): SquareClient =>
  ({
    checkout: { paymentLinks: { delete: deleteLink } },
    orders: { get: readOrder },
  }) as unknown as SquareClient;

const cancelled = fakeClient(
  () => Promise.resolve({ cancelled_order_id: "order_1", id: "link_1" }),
  () =>
    Promise.resolve({
      order: { id: "order_1", state: "CANCELED", tenders: [] },
    }),
);

const stagedRow = async (sessionId: string): Promise<boolean> =>
  (await queryOne<{ session_index: string }>(
    "SELECT session_index FROM checkout_pending_answers WHERE session_index = ?",
    [await sessionWorkIndex(sessionId)],
  )) !== null;

/** A staged Square checkout, already old enough to cancel. */
const stageSquare = async (
  sessionId: string,
  linkId: string,
): Promise<void> => {
  await stageCheckoutAnswers(sessionId, { "7": "Coming by bus" }, [], linkId);
  await execute(
    "UPDATE checkout_pending_answers SET next_check_at = '2000-01-01T00:00:00.000Z' WHERE session_index = ?",
    [await sessionWorkIndex(sessionId)],
  );
};

describeWithEnv("square checkout cancellation", { db: true }, () => {
  let getClient: { restore(): void };

  beforeEach(() => {
    clients.current = cancelled;
    getClient = stub(squareApi, "getSquareClient", () =>
      Promise.resolve(clients.current),
    );
  });

  afterEach(() => {
    getClient.restore();
  });

  test("deletes staged answers after a confirmed cancellation", async () => {
    await stageSquare("order_1", "link_1");

    expect(await runSquareCheckoutCancellation()).toBe(false);

    expect(await stagedRow("order_1")).toBe(false);
  });

  test("keeps the staged row while a local payment owns the session", async () => {
    await stageSquare("order_2", "link_2");
    await execute(
      "INSERT INTO processed_payments (payment_session_id, processed_at) VALUES (?, ?)",
      ["order_2", "2026-09-01T00:00:00.000Z"],
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_2")).toBe(true);
  });

  test("keeps the staged row when the order is not cancelled", async () => {
    await stageSquare("order_3", "link_3");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_3", id: "link_3" }),
      () =>
        Promise.resolve({
          order: { id: "order_3", state: "OPEN", tenders: [] },
        }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_3")).toBe(true);
  });

  test("keeps the staged row when Square cancelled another checkout", async () => {
    await stageSquare("order_4", "link_4");
    clients.current = fakeClient(
      () =>
        Promise.resolve({ cancelled_order_id: "other_order", id: "link_4" }),
      () =>
        Promise.resolve({
          order: { id: "order_4", state: "CANCELED", tenders: [] },
        }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_4")).toBe(true);
  });

  // The row disappears from under the worker only in a race with another
  // worker that already claimed it; the trigger replays losing that race.
  test("skips a row whose claim was lost to another worker", async () => {
    await stageSquare("order_6", "link_6");
    let deleteCalls = 0;
    clients.current = fakeClient(
      () => {
        deleteCalls += 1;
        return Promise.resolve({
          cancelled_order_id: "order_6",
          id: "link_6",
        });
      },
      () => Promise.resolve({ order: null }),
    );
    await execute(
      `CREATE TEMP TRIGGER block_claim
         BEFORE UPDATE ON checkout_pending_answers
         WHEN NEW.state = 'cancelling'
         BEGIN SELECT RAISE(IGNORE); END`,
      [],
    );
    try {
      await runSquareCheckoutCancellation();
    } finally {
      await execute("DROP TRIGGER block_claim", []);
    }

    expect(deleteCalls).toBe(0);
    const row = await queryOne<{ state: string }>(
      "SELECT state FROM checkout_pending_answers WHERE session_index = ?",
      [await sessionWorkIndex("order_6")],
    );
    expect(row?.state).toBe("open");
  });

  test("reports no work without asking for a client when nothing is staged", async () => {
    getClient.restore();
    let clientAsked = false;
    getClient = stub(squareApi, "getSquareClient", () => {
      clientAsked = true;
      return Promise.resolve(null);
    });

    expect(await runSquareCheckoutCancellation()).toBe(false);
    expect(clientAsked).toBe(false);
  });

  test("throws when no Square client is configured", async () => {
    await stageSquare("order_7", "link_7");
    getClient.restore();
    getClient = stub(squareApi, "getSquareClient", () => Promise.resolve(null));

    await expect(runSquareCheckoutCancellation()).rejects.toThrow(
      "Square cancellation needs a Square client",
    );
    expect(await stagedRow("order_7")).toBe(true);
  });

  test("keeps the staged row when the cancelled order carries a tender", async () => {
    await stageSquare("order_8", "link_8");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_8", id: "link_8" }),
      () =>
        Promise.resolve({
          order: {
            id: "order_8",
            state: "CANCELED",
            tenders: [{ id: "t_1" }],
          },
        }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_8")).toBe(true);
  });

  test("keeps the staged row when Square no longer knows the order", async () => {
    await stageSquare("order_9", "link_9");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_9", id: "link_9" }),
      () => Promise.resolve({ order: null }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_9")).toBe(true);
  });

  test("deletes the staged row when the cancelled order omits its tenders", async () => {
    await stageSquare("order_10", "link_10");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_10", id: "link_10" }),
      () =>
        Promise.resolve({
          order: { id: "order_10", state: "CANCELED" },
        }),
    );

    await runSquareCheckoutCancellation();

    // An order with no tenders field counts as one with no tenders at all.
    expect(await stagedRow("order_10")).toBe(false);
  });

  test("keeps the staged row when the order names another checkout", async () => {
    await stageSquare("order_11", "link_11");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_11", id: "link_11" }),
      () =>
        Promise.resolve({
          order: { id: "order_other", state: "CANCELED", tenders: [] },
        }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_11")).toBe(true);
  });

  test("keeps the staged row when the order was never cancelled", async () => {
    await stageSquare("order_12", "link_12");
    clients.current = fakeClient(
      () => Promise.resolve({ cancelled_order_id: "order_12", id: "link_12" }),
      () =>
        Promise.resolve({
          order: { id: "order_12", state: "OPEN", tenders: [] },
        }),
    );

    await runSquareCheckoutCancellation();

    expect(await stagedRow("order_12")).toBe(true);
  });

  test("releases its claim when the provider call fails", async () => {
    await stageSquare("order_5", "link_5");
    clients.current = fakeClient(
      () => Promise.reject(new Error("network gone")),
      () =>
        Promise.resolve({
          order: { id: "order_5", state: "CANCELED", tenders: [] },
        }),
    );

    await runSquareCheckoutCancellation();

    // The failed claim is released back to open, not destroyed.
    const row = await queryOne<{ state: string }>(
      "SELECT state FROM checkout_pending_answers WHERE session_index = ?",
      [await sessionWorkIndex("order_5")],
    );
    expect(row?.state).toBe("open");
  });
});
