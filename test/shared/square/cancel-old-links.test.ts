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
let client: SquareClient;

const fakeClient = (
  deleteLink: () => Promise<{ cancelled_order_id: string; id: string }>,
  readOrder: () => Promise<{
    order: { id: string; state: string; tenders: unknown[] } | null;
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
    client = cancelled;
    getClient = stub(squareApi, "getSquareClient", () =>
      Promise.resolve(client),
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
    client = fakeClient(
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
    client = fakeClient(
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

  test("releases its claim when the provider call fails", async () => {
    await stageSquare("order_5", "link_5");
    client = fakeClient(
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
