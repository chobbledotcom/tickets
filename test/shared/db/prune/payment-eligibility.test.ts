import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { recordPaymentCase } from "#shared/db/payments/cases.ts";
import { requestChargeRefund } from "#shared/db/payments/charges.ts";
import { consumePaymentTicketTokens } from "#shared/db/payments/sessions.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  oldPaymentTime,
  redactedAt,
  seedTerminalPayment,
} from "./payment-redaction-helpers.ts";

describeWithEnv("db > payment redaction eligibility", { db: true }, () => {
  test("redacts only fully terminal inactive payments", async () => {
    const eligible = await seedTerminalPayment("eligible");
    const recent = await seedTerminalPayment("recent", {
      createdAt: Date.now(),
    });
    const active = await seedTerminalPayment("active", { state: "processing" });
    const ticketReady = await seedTerminalPayment("ticket-ready", {
      ticketReady: true,
    });
    const leased = await seedTerminalPayment("leased", { lease: true });
    const due = await seedTerminalPayment("due", {
      nextReconcileAt: oldPaymentTime(),
    });
    const incomplete = await seedTerminalPayment("completion-pending", {
      completionState: "pending",
    });
    const refundPending = await seedTerminalPayment("refund-pending");
    const refundRows = await getDb().execute({
      args: [refundPending.id],
      sql: "SELECT id FROM payment_charges WHERE payment_id = ?",
    });
    await requestChargeRefund(
      Number(refundRows.rows[0]!.id),
      "pending-refund-key",
    );
    const openCase = await seedTerminalPayment("open-case");
    await recordPaymentCase(
      {
        evidence: openCase.intent,
        nextReconcileAt: null,
        paymentId: openCase.id,
        reason: "operator_review",
        resource: openCase.session,
        state: "needs_action",
      },
      oldPaymentTime(),
    );

    await runDatabasePruning();

    expect(await redactedAt(eligible.id)).not.toBeNull();
    for (const payment of [
      recent,
      active,
      ticketReady,
      leased,
      due,
      incomplete,
      refundPending,
      openCase,
    ]) {
      expect(await redactedAt(payment.id)).toBeNull();
    }
  });

  test("does not redact an unconsumed ticket even when every other fact is terminal", async () => {
    const payment = await seedTerminalPayment("unconsumed-ticket", {
      ticketReady: true,
    });

    await runDatabasePruning();

    const row = await getDb().execute({
      args: [payment.id],
      sql: "SELECT ticket_state, ticket_tokens, redacted_at FROM payment_sessions WHERE id = ?",
    });
    expect(row.rows[0]).toMatchObject({
      redacted_at: null,
      ticket_state: "ready",
    });
    expect(row.rows[0]?.ticket_tokens).not.toBeNull();
  });

  test("redacts an old completed payment after its callback ticket is consumed", async () => {
    const payment = await seedTerminalPayment("consumed-ticket", {
      ticketReady: true,
    });

    expect(await consumePaymentTicketTokens(payment.id)).toBe(true);
    await runDatabasePruning();

    expect(await redactedAt(payment.id)).not.toBeNull();
  });

  test("redacts a fully refunded payment with settled exact money", async () => {
    const payment = await seedTerminalPayment("fully-refunded", {
      state: "fully_refunded",
    });
    await getDb().execute({
      args: [payment.id],
      sql: `UPDATE payment_charges
        SET refunded_amount = captured_amount, refund_state = 'completed'
        WHERE payment_id = ?`,
    });

    await runDatabasePruning();

    expect(await redactedAt(payment.id)).not.toBeNull();
  });

  test("redacts an old failed current payment with no remaining work", async () => {
    const payment = await seedTerminalPayment("failed-current", {
      completionState: "none",
      state: "failed",
      storeResult: false,
    });

    await runDatabasePruning();

    expect(await redactedAt(payment.id)).not.toBeNull();
  });
});
