import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb } from "#shared/db/client.ts";
import {
  PAYMENT_SESSION_COLUMNS,
  readPaymentSessionRow,
  type StoredPaymentSessionRow,
} from "#shared/db/payments/session-record.ts";
import {
  createPaymentSession,
  getPaymentSessions,
} from "#shared/db/payments/sessions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  PAYMENT_CHECKOUT_CREATE,
  PAYMENT_ID,
  PAYMENT_TIME,
  paymentSessionInput,
  SESSION_RESOURCE,
} from "./fixtures.ts";

describeWithEnv("db > payments > stored session rows", { db: true }, () => {
  test("indexes the stable provider session identity", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const result = await getDb().execute(
      `SELECT booking_intent, session_resource, session_reference_index
         FROM payment_sessions WHERE id = ?`,
      [PAYMENT_ID],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("Expected the stored payment session");

    expect(String(row.booking_intent)).toMatch(/^enc:1:/);
    expect(String(row.session_resource)).toMatch(/^enc:1:/);
    expect(row.session_reference_index).toBe(
      await hmacHash(JSON.stringify(SESSION_RESOURCE)),
    );
    expect(JSON.stringify(row)).not.toContain(SESSION_RESOURCE.id);
    expect(JSON.stringify(row)).not.toContain("listingId");
  });

  test("round-trips the exact encrypted checkout creation snapshot", async () => {
    await createPaymentSession(
      {
        ...paymentSessionInput(PAYMENT_ID, null),
        checkoutCreate: PAYMENT_CHECKOUT_CREATE,
      },
      PAYMENT_TIME,
    );
    const result = await getDb().execute(
      "SELECT checkout_create FROM payment_sessions WHERE id = ?",
      [PAYMENT_ID],
    );

    expect(String(result.rows[0]?.checkout_create)).toMatch(/^enc:1:/);
    expect(String(result.rows[0]?.checkout_create)).not.toContain(
      PAYMENT_CHECKOUT_CREATE.bookingIntent.email,
    );
    expect((await getPaymentSessions([PAYMENT_ID]))[0]?.checkoutCreate).toEqual(
      PAYMENT_CHECKOUT_CREATE,
    );
  });

  test("accepts stored zero boundaries and the first attendee", async () => {
    await createPaymentSession(
      {
        ...paymentSessionInput(),
        expected: { amount: 0, currency: "GBP" },
      },
      0,
    );
    await getDb().execute(`UPDATE payment_sessions
      SET attendee_id = 1, lease_token = 'lease', lease_expires_at = 0,
          next_reconcile_at = 0`);

    expect((await getPaymentSessions([PAYMENT_ID]))[0]).toMatchObject({
      attendeeId: 1,
      createdAt: 0,
      expected: { amount: 0, currency: "GBP" },
      leaseExpiresAt: 0,
      nextReconcileAt: 0,
      revision: 1,
      updatedAt: 0,
    });
  });

  test("rejects invalid stored attendee and revision boundaries", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    const result = await getDb().execute(
      `SELECT ${PAYMENT_SESSION_COLUMNS.join(", ")}
         FROM payment_sessions WHERE id = ?`,
      [PAYMENT_ID],
    );
    const row = result.rows[0];
    if (row === undefined)
      throw new Error("Expected the stored payment session");
    const stored = row as unknown as StoredPaymentSessionRow;

    await expect(
      readPaymentSessionRow({ ...stored, attendee_id: 0 }),
    ).rejects.toThrow();
    await expect(
      readPaymentSessionRow({ ...stored, revision: 0 }),
    ).rejects.toThrow();
  });

  test("fails loudly when stored intent is malformed", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    await getDb().execute(
      "UPDATE payment_sessions SET booking_intent = ? WHERE id = ?",
      [await encrypt('{"items":'), PAYMENT_ID],
    );

    await expect(getPaymentSessions([PAYMENT_ID])).rejects.toThrow(
      "payment_sessions.booking_intent",
    );
  });

  test("fails loudly when the stored provider disagrees with its resource", async () => {
    await createPaymentSession(paymentSessionInput(), PAYMENT_TIME);
    await getDb().execute(
      "UPDATE payment_sessions SET provider = 'square' WHERE id = ?",
      [PAYMENT_ID],
    );

    await expect(getPaymentSessions([PAYMENT_ID])).rejects.toThrow(
      "Invalid stored provider resource",
    );
  });
});
