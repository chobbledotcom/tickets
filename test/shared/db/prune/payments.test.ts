import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { getDb, queryOne } from "#shared/db/client.ts";
import {
  getPaymentCharges,
  requestChargeRefund,
} from "#shared/db/payments/charges.ts";
import { paymentStoredJson } from "#shared/db/payments/codecs.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { reconcilePayment } from "#shared/payment-runtime/process.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  redactedAt,
  seedTerminalPayment,
} from "./payment-redaction-helpers.ts";

interface StoredPayloads {
  booking_intent: EnvKeyEncrypted;
  checkout_create: EnvKeyEncrypted | null;
  completion: EnvKeyEncrypted;
  legacy_runtime: EnvKeyEncrypted | null;
  result: EnvKeyEncrypted;
  session_reference_index: string;
  session_resource: EnvKeyEncrypted;
}

const storedPayloads = (id: string): Promise<StoredPayloads | null> =>
  queryOne<StoredPayloads>(
    `SELECT booking_intent, checkout_create, completion, legacy_runtime,
            result, session_reference_index, session_resource
       FROM payment_sessions WHERE id = ?`,
    [id],
  );

describeWithEnv("db > payment history redaction", { db: true }, () => {
  test("redacts old terminal PII while preserving replay resources", async () => {
    const seeded = await seedTerminalPayment("eligible-private");
    const before = await storedPayloads(seeded.id);
    if (before === null) throw new Error("Expected stored payment payloads");

    await runDatabasePruning();

    const after = await storedPayloads(seeded.id);
    if (after === null) throw new Error("Expected redacted payment payloads");
    expect(await redactedAt(seeded.id)).not.toBeNull();
    expect(after.checkout_create).toBeNull();
    expect(after.legacy_runtime).toBeNull();
    expect(after.session_resource).toBe(before.session_resource);
    expect(after.session_reference_index).toBe(before.session_reference_index);
    expect(after.booking_intent).not.toBe(before.booking_intent);
    expect(after.completion).not.toBe(before.completion);
    expect(after.result).not.toBe(before.result);

    const [intent, completion, result, session] = await Promise.all([
      paymentStoredJson.bookingIntent.open(
        after.booking_intent,
        "redacted intent",
      ),
      paymentStoredJson.completion.open(
        after.completion,
        "redacted completion",
      ),
      paymentStoredJson.result.open(after.result, "redacted result"),
      paymentStoredJson.sessionResource.open(
        after.session_resource,
        "preserved session",
      ),
    ]);
    const decrypted = JSON.stringify({ completion, intent, result });
    expect(decrypted).not.toContain(seeded.intent.name);
    expect(decrypted).not.toContain(seeded.intent.email);
    expect(decrypted).not.toContain(seeded.intent.address);
    expect(decrypted).not.toContain(seeded.intent.special_instructions);
    expect(intent).toEqual({
      address: "",
      date: null,
      email: "",
      items: seeded.intent.items,
      modifiers: [],
      name: "",
      phone: "",
      special_instructions: "",
    });
    expect(completion.input).toEqual(intent);
    if (!("observation" in result) || result.observation === undefined) {
      throw new Error("Expected stored terminal observation");
    }
    expect(result.observation.bookingIntent).toEqual(intent);
    expect(session).toEqual(seeded.session);
  });

  test("replays a completed callback after redaction", async () => {
    const seeded = await seedTerminalPayment("replay-after-redaction");
    await runDatabasePruning();

    const outcome = await reconcilePayment(
      "stripe",
      { id: seeded.id, kind: "local" },
      () => Promise.reject(new Error("Terminal replay must not fulfil again")),
    );

    expect(outcome).toMatchObject({ replayed: true, status: "completed" });
    expect(outcome.payment?.id).toBe(seeded.id);
  });

  test("redacts a terminal session without a stored result", async () => {
    const seeded = await seedTerminalPayment("redaction-without-result", {
      storeResult: false,
    });

    await runDatabasePruning();

    const [payment] = await getPaymentSessions([seeded.id]);
    expect(payment).toMatchObject({
      id: seeded.id,
      result: null,
      resultState: "none",
    });
    expect(await redactedAt(seeded.id)).not.toBeNull();
  });

  test("keeps exact charge money and permits a later refund request", async () => {
    const seeded = await seedTerminalPayment("refund-after-redaction");
    await runDatabasePruning();

    const [charge] = await getPaymentCharges(seeded.id);
    if (charge === undefined || !("captured" in charge)) {
      throw new Error("Expected current payment charge");
    }
    expect(charge).toMatchObject({
      captured: { amount: 1_000, currency: "GBP" },
      providerReference: seeded.charge,
      refunded: { amount: 0, currency: "GBP" },
      refundState: "none",
    });

    const request = await requestChargeRefund(
      charge.id,
      "refund-after-redaction-key",
    );

    expect(request).toEqual({
      chargeId: charge.id,
      idempotencyKey: "refund-after-redaction-key",
    });
  });

  test("fails loudly instead of redacting malformed encrypted state", async () => {
    const seeded = await seedTerminalPayment("malformed-redaction");
    const malformed = await paymentStoredJson.decisionError.seal(
      "not a booking intent",
      "malformed payment test",
    );
    await queryOne(
      "UPDATE payment_sessions SET booking_intent = ? WHERE id = ? RETURNING id",
      [malformed, seeded.id],
    );

    await expect(runDatabasePruning()).rejects.toThrow();

    expect(await redactedAt(seeded.id)).toBeNull();
  });

  test("fails if stored payment changes while redaction is being written", async () => {
    const seeded = await seedTerminalPayment("redaction-write-race");
    const changedIntent = await paymentStoredJson.bookingIntent.seal(
      { ...seeded.intent, name: "Changed during redaction" },
      "payment redaction race test",
    );
    const client = getDb();
    const batch = client.batch.bind(client);
    let changed = false;
    using _batch = stub(client, "batch", async (...args) => {
      if (!changed) {
        changed = true;
        await client.execute({
          args: [changedIntent, seeded.id],
          sql: "UPDATE payment_sessions SET booking_intent = ? WHERE id = ?",
        });
      }
      return await batch(...args);
    });

    await expect(runDatabasePruning()).rejects.toThrow(
      "Payment history changed while it was being redacted",
    );

    expect(await redactedAt(seeded.id)).toBeNull();
  });

  test("loads the redacted session through the normal stored schema", async () => {
    const seeded = await seedTerminalPayment("schema-valid-redaction");
    await runDatabasePruning();

    const [payment] = await getPaymentSessions([seeded.id]);

    expect(payment).toMatchObject({
      attendeeId: 42,
      bookingIntent: { email: "", name: "" },
      completionState: "completed",
      id: seeded.id,
      state: "completed",
      ticketState: "consumed",
    });
  });
});
