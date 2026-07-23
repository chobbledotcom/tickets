import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { KIND } from "#shared/accounting/kinds.ts";
import { selectDueCheckoutStages } from "#shared/db/checkout-stage-recovery.ts";
import {
  beginCheckoutStageRefund,
  checkoutStageClaimStatement,
  finalizeCheckoutStageRefund,
  findCheckoutStage,
  loadCheckoutStageByPaymentSession,
  pendingCheckoutStageInsert,
  purgePendingCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import {
  isSessionProcessed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  insertCheckoutStage,
  testCheckoutRefund,
} from "#test-utils/checkout-stages.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestSystemNote } from "#test-utils/system-notes.ts";
import { attendeeExists, insertOrphanAttendee } from "./prune/helpers.ts";

const old = "2026-07-01T00:00:00.000Z";

describeWithEnv("db > checkout stages", { db: true }, () => {
  test("builds the exact stage claim identity", () => {
    expect(
      checkoutStageClaimStatement(
        { attendeeId: 42, paymentSessionId: "claim-session" },
        "refunding",
      ),
    ).toEqual({
      args: ["claim-session", 42, "refunding"],
      sql: `UPDATE checkout_stages SET state = state
         WHERE payment_session_id = ? AND attendee_id = ? AND state = ?`,
    });
  });

  test("builds a pending insert with encrypted token and provider identity", async () => {
    const statement = await pendingCheckoutStageInsert(
      {
        paymentSessionId: "insert-session",
        provider: "stripe",
        providerCheckoutId: "provider-checkout",
      },
      "(SELECT ?)",
      [77],
      "plain-token",
    );
    expect(statement.args.slice(0, 4)).toEqual([
      "insert-session",
      77,
      "stripe",
      "provider-checkout",
    ]);
    expect(statement.args.slice(5, 7)).toEqual(["", "pending"]);
    expect(String(statement.args[4])).not.toContain("plain-token");
    expect(Number(statement.args[8])).toBeGreaterThan(Date.now());
    expect(statement.args.slice(9)).toEqual([0, null]);
    expect(statement.sql).toContain(
      "VALUES (?, (SELECT ?), ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
  });

  test("finds only the exact attendee token and loads the full stage", async () => {
    const attendeeId = await insertOrphanAttendee(old);
    await insertCheckoutStage(attendeeId, "load-session", {
      providerCheckoutId: "provider-load",
    });

    expect(
      await findCheckoutStage("load-session", attendeeId, "wrong-token"),
    ).toBeNull();
    expect(
      await findCheckoutStage(
        "load-session",
        attendeeId + 1,
        "token-load-session",
      ),
    ).toBeNull();
    expect(
      await findCheckoutStage("load-session", attendeeId, "token-load-session"),
    ).toMatchObject({
      attendeeId,
      paymentSessionId: "load-session",
      provider: "stripe",
      providerCheckoutId: "provider-load",
      refund: null,
      state: "pending",
      ticketToken: "token-load-session",
    });
    expect(await loadCheckoutStageByPaymentSession("missing-stage")).toBeNull();
  });

  test("selects every due stage in queue order", async () => {
    const ids = await Promise.all(
      Array.from({ length: 5 }, async (_, index) => {
        const attendeeId = await insertOrphanAttendee(old);
        await insertCheckoutStage(attendeeId, `old-${index}`, {
          createdAt: old,
          nextAttemptAt: index,
        });
        return attendeeId;
      }),
    );
    const refundingId = await insertOrphanAttendee(old);
    await insertCheckoutStage(refundingId, "old-refunding", {
      createdAt: old,
      nextAttemptAt: 5,
      state: "refunding",
    });

    const selected = await selectDueCheckoutStages();
    expect(selected.map((stage) => stage.paymentSessionId)).toEqual([
      "old-0",
      "old-1",
      "old-2",
      "old-3",
      "old-4",
      "old-refunding",
    ]);
    expect(selected.map((stage) => stage.attendeeId)).toEqual([
      ...ids,
      refundingId,
    ]);
  });

  test("purges an unclaimed pending stage but keeps a claimed stage", async () => {
    const purgedId = await insertOrphanAttendee(old);
    await insertCheckoutStage(purgedId, "purge-stage");
    await createTestSystemNote(purgedId, "Remove with stage");
    const purged = (await selectDueCheckoutStages()).find(
      (stage) => stage.paymentSessionId === "purge-stage",
    )!;
    expect(await purgePendingCheckoutStage(purged)).toBe(true);
    expect(await attendeeExists(purgedId)).toBe(false);
    const purgedNotes = await getDb().execute(
      "SELECT id FROM system_notes WHERE attendee_id = ?",
      [purgedId],
    );
    expect(purgedNotes.rows).toEqual([]);

    const keptId = await insertOrphanAttendee(old);
    await insertCheckoutStage(keptId, "keep-stage");
    await reserveSession("keep-stage");
    const kept = (await selectDueCheckoutStages()).find(
      (stage) => stage.paymentSessionId === "keep-stage",
    )!;
    expect(await purgePendingCheckoutStage(kept)).toBe(false);
    expect(await attendeeExists(keptId)).toBe(true);
  });

  test("stores a refund reason and finalizes its payment and cleanup atomically", async () => {
    const attendeeId = await insertOrphanAttendee(old);
    await insertCheckoutStage(attendeeId, "refund-stage");
    await createTestSystemNote(attendeeId, "Remove after refund");
    await reserveSession("refund-stage");
    const refund = testCheckoutRefund("capacity_full");
    await beginCheckoutStageRefund("refund-stage", refund);
    const stage = await loadCheckoutStageByPaymentSession("refund-stage");
    expect(stage).toMatchObject({ refund, state: "refunding" });
    if (!stage) throw new Error("Expected refund stage");

    await finalizeCheckoutStageRefund({
      failure: { error: "Sold out", refunded: true, status: 409 },
      legs: [
        {
          amount: 100,
          destination: WORLD,
          eventGroup: "checkout-refund",
          kind: KIND.refundCash,
          occurredAt: old,
          reference: "checkout-refund-reference",
          source: attendeeAccount(attendeeId),
        },
      ],
      paymentReference: "pi_refund_stage",
      stage,
    });

    expect(await loadCheckoutStageByPaymentSession("refund-stage")).toBeNull();
    expect(await attendeeExists(attendeeId)).toBe(false);
    const refundNotes = await getDb().execute(
      "SELECT id FROM system_notes WHERE attendee_id = ?",
      [attendeeId],
    );
    expect(refundNotes.rows).toEqual([]);
    const payment = (await isSessionProcessed("refund-stage"))!;
    expect(payment.failure_data).not.toBe("");
    expect(payment.payment_reference).not.toBe("");
    expect(payment.provider_refunded_at).not.toBe("");
    const refundTransfers = await getDb().execute(
      "SELECT kind, source_id, dest_id FROM transfers WHERE reference = 'checkout-refund-reference'",
    );
    expect(refundTransfers.rows).toEqual([
      {
        dest_id: "world",
        kind: "refund_cash",
        source_id: String(attendeeId),
      },
    ]);
  });

  test("rejects an invalid refund transition", async () => {
    await expect(
      beginCheckoutStageRefund("missing-refund-stage", testCheckoutRefund()),
    ).rejects.toThrow(
      "Checkout stage missing-refund-stage did not enter refunding",
    );
  });

  test("rolls back when only the refund stage can be claimed", async () => {
    const attendeeId = await insertOrphanAttendee(old);
    await insertCheckoutStage(attendeeId, "refund-without-payment", {
      state: "refunding",
    });
    const stage = await loadCheckoutStageByPaymentSession(
      "refund-without-payment",
    );
    if (!stage) throw new Error("Expected refund stage");

    await expect(
      finalizeCheckoutStageRefund({
        failure: { error: "Refunded", refunded: true },
        legs: [
          {
            amount: 100,
            destination: WORLD,
            eventGroup: "unclaimed-refund",
            kind: KIND.refundCash,
            occurredAt: old,
            reference: "unclaimed-refund-reference",
            source: attendeeAccount(attendeeId),
          },
        ],
        paymentReference: "pi_unclaimed",
        stage,
      }),
    ).rejects.toThrow(
      "Checkout refund refund-without-payment was not ready to finalize",
    );
    expect(
      await loadCheckoutStageByPaymentSession("refund-without-payment"),
    ).toMatchObject({ attendeeId, state: "refunding" });
    expect(await attendeeExists(attendeeId)).toBe(true);
  });
});
