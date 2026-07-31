import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  restoreLegacyPaymentSources,
  runMigration,
} from "./payment-aggregate-test-utils.ts";

describeWithEnv("payment aggregate attendee migration", { db: true }, () => {
  beforeEach(restoreLegacyPaymentSources);

  test("quarantines an attendee-only encrypted payment reference unchanged", async () => {
    const piiBlob = await encryptPiiBlob(
      buildPiiBlob({
        address: "",
        email: "legacy@example.com",
        lat: "",
        lng: "",
        name: "Legacy attendee",
        payment_id: "pi_attendee_only",
        phone: "",
        special_instructions: "",
        ticket_token: "legacy-ticket",
      }),
      settings.publicKey,
    );
    await getDb().batch(
      [
        {
          args: [42, "2026-07-25T09:00:00.000Z", piiBlob, "ticket-index"],
          sql: `INSERT INTO attendees (id, created, pii_blob, ticket_token_index)
            VALUES (?, ?, ?, ?)`,
        },
        {
          args: ["legacy-payment-leg"],
          sql: `INSERT INTO transfers
            (source_type, source_id, dest_type, dest_id, amount, occurred_at,
             recorded_at, reference, event_group, kind)
            VALUES ('external', 'world', 'attendee', '42', 1000, 1, 1, ?,
              'legacy-order', 'payment')`,
        },
      ],
      "write",
    );

    await runMigration();

    const session = await getDb().execute(`SELECT id, attendee_id, provider,
        account_id, expected_amount, state
      FROM payment_sessions WHERE id = 'legacy:attendee:42'`);
    expect(session.rows).toEqual([
      {
        account_id: null,
        attendee_id: 42,
        expected_amount: null,
        id: "legacy:attendee:42",
        provider: null,
        state: "needs_action",
      },
    ]);
    const charge = await getDb().execute(`SELECT provider_reference,
        legacy_source, provider, captured_amount
      FROM payment_charges WHERE payment_id = 'legacy:attendee:42'`);
    expect(charge.rows).toEqual([
      {
        captured_amount: null,
        legacy_source: "attendees.pii_blob",
        provider: null,
        provider_reference: piiBlob,
      },
    ]);
    const paymentCase = await getDb().execute(
      `SELECT reason, state FROM payment_cases
        WHERE payment_id = 'legacy:attendee:42'`,
    );
    expect(paymentCase.rows).toEqual([
      { reason: "legacy_provider_unknown", state: "needs_action" },
    ]);
  });

  test("brings forward a paid booking refunded down to no quantity", async () => {
    // The booking still names its listing even with nothing left on it. If the
    // upgrade skipped it, the copied record would have a buyer and no listing,
    // which it refuses to write — so the whole upgrade would stop here.
    await getDb().batch(
      [
        {
          args: [
            42,
            "2026-07-25T09:00:00.000Z",
            "hyb:1:key:iv:legacy-pii",
            "tok-0",
          ],
          sql: `INSERT INTO attendees (id, created, pii_blob, ticket_token_index)
            VALUES (?, ?, ?, ?)`,
        },
        {
          args: [],
          sql: `INSERT INTO listing_attendees
            (listing_id, attendee_id, quantity) VALUES (7, 42, 0)`,
        },
        {
          args: [
            "sess-no-quantity",
            42,
            "2026-07-25T10:01:00.000Z",
            await encrypt("legacy-ticket"),
          ],
          sql: `INSERT INTO processed_payments
            (payment_session_id, attendee_id, processed_at, ticket_tokens)
            VALUES (?, ?, ?, ?)`,
        },
      ],
      "write",
    );

    await runMigration();

    const rows = await getDb().execute(
      "SELECT origin, attendee_id FROM payment_sessions",
    );
    expect(rows.rows).toEqual([{ attendee_id: 42, origin: "legacy" }]);
  });
});
