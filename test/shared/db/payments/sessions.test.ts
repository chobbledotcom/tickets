import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import {
  createPaymentSession,
  getPaymentSessionByResourceOrNull,
  getPaymentSessionByResourceOrNullPrimary,
  getPaymentSessions,
  getPaymentSessionsPrimary,
} from "#shared/db/payments/sessions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  PAYMENT_ID,
  PAYMENT_INTENT,
  PAYMENT_TIME,
  paymentSessionInput,
} from "./fixtures.ts";

describeWithEnv("db > payments > sessions", { db: true }, () => {
  test("creates a current session before provider IO", async () => {
    const session = await createPaymentSession(
      paymentSessionInput(PAYMENT_ID, null),
      PAYMENT_TIME,
    );

    expect(session).toEqual({
      accountId: "acct_test_1",
      attendeeId: null,
      bookingIntent: PAYMENT_INTENT,
      checkoutCreate: null,
      completion: null,
      completionState: "none",
      createdAt: PAYMENT_TIME,
      expected: { amount: 1_000, currency: "GBP" },
      id: PAYMENT_ID,
      leaseExpiresAt: null,
      mode: "test",
      nextReconcileAt: null,
      provider: "stripe",
      result: null,
      resultState: "none",
      revision: 1,
      session: null,
      state: "created",
      ticketState: "none",
      ticketTokens: null,
      updatedAt: PAYMENT_TIME,
    });
    expect(await getPaymentSessions([PAYMENT_ID])).toEqual([session]);
  });

  test("reads one or many current sessions in input order", async () => {
    await createPaymentSession(paymentSessionInput("payment-a"), PAYMENT_TIME);
    await createPaymentSession(paymentSessionInput("payment-b"), PAYMENT_TIME);

    const sessions = await getPaymentSessions([
      "payment-b",
      "missing-payment",
      "payment-a",
      "payment-b",
    ]);

    expect(sessions.map((session) => session?.id ?? null)).toEqual([
      "payment-b",
      null,
      "payment-a",
      "payment-b",
    ]);
    expect(await getPaymentSessions([])).toEqual([]);
  });

  test("finds a current payment by its provider session resource", async () => {
    const created = await createPaymentSession(
      paymentSessionInput(PAYMENT_ID),
      PAYMENT_TIME,
    );
    const resource = created.session;
    if (resource === null) throw new Error("Expected a provider session");

    expect(await getPaymentSessionByResourceOrNull(resource)).toEqual(created);
    expect(
      await getPaymentSessionByResourceOrNull({
        ...resource,
        id: "unknown-session",
      }),
    ).toBeNull();
  });

  test("pins callback and local-id lookups to the primary", async () => {
    const created = await createPaymentSession(
      paymentSessionInput(PAYMENT_ID),
      PAYMENT_TIME,
    );
    const resource = created.session;
    if (resource === null) throw new Error("Expected a provider session");
    const modes: string[] = [];
    const client = getDb();
    const batch = client.batch.bind(client);
    using _batch = stub(client, "batch", (statements, mode) => {
      modes.push(mode ?? "");
      return batch(statements, mode);
    });

    expect(await getPaymentSessionsPrimary([PAYMENT_ID])).toEqual([created]);
    expect(await getPaymentSessionByResourceOrNullPrimary(resource)).toEqual(
      created,
    );
    expect(modes).toEqual(["write", "write"]);
  });
});
