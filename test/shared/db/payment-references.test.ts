import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import {
  encryptPaymentReference,
  getRefundPaymentReferences,
  hasRefundPaymentReference,
  legacyMergePaymentReferenceStatement,
  markPaymentReferencesProviderRefunded,
} from "#shared/db/payment-references.ts";
import {
  finalizeSession as finalizePaymentSession,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import {
  bookAttendee,
  createTestListing,
  describeWithEnv,
  getTestPrivateKey,
} from "#test-utils";

describeWithEnv("db > payment references", { db: true }, () => {
  test("encrypts non-empty references and leaves empty references empty", async () => {
    expect(await encryptPaymentReference("")).toBe("");
    expect(await encryptPaymentReference("pi_secret")).not.toContain(
      "pi_secret",
    );
  });

  test("returns an empty map for no attendees", async () => {
    expect(
      await getRefundPaymentReferences([], await getTestPrivateKey()),
    ).toEqual(new Map());
  });

  test("includes legacy payment_id alongside processed-payment references", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const first = await bookAttendee(listing, {
      email: "refs1@example.com",
      name: "Refs One",
    });
    const second = await bookAttendee(listing, {
      email: "refs2@example.com",
      name: "Refs Two",
    });
    if (!first.success || !second.success) throw new Error("setup failed");
    const firstId = first.attendees[0]!.id;
    const secondId = second.attendees[0]!.id;

    await reserveSession("sess_refs_a");
    await finalizePaymentSession("sess_refs_a", firstId, [], "pi_recorded");
    await reserveSession("sess_refs_b");
    await finalizePaymentSession("sess_refs_b", firstId, [], "pi_recorded");

    const references = await getRefundPaymentReferences(
      [
        { id: firstId, payment_id: "pi_legacy_ignored" },
        { id: secondId, payment_id: "pi_legacy_used" },
        { id: 9999, payment_id: "" },
      ],
      await getTestPrivateKey(),
    );

    expect(references.get(firstId)?.map((entry) => entry.reference)).toEqual([
      "pi_recorded",
      "pi_legacy_ignored",
    ]);
    expect(references.get(secondId)?.map((entry) => entry.reference)).toEqual([
      "pi_legacy_used",
    ]);
    expect(references.get(9999)).toEqual([]);
  });

  test("does not duplicate legacy payment_id already recorded on processed payment", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "refs-duplicate@example.com",
      name: "Refs Duplicate",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;

    await reserveSession("sess_refs_duplicate");
    await finalizePaymentSession(
      "sess_refs_duplicate",
      attendeeId,
      [],
      "pi_duplicate",
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "pi_duplicate" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)?.map((entry) => entry.reference)).toEqual(
      ["pi_duplicate"],
    );
  });

  test("reads merged legacy payment IDs as session-less refund references", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "merged-legacy-ref@example.com",
      name: "Merged Legacy Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const statement = await legacyMergePaymentReferenceStatement(
      attendeeId,
      12345,
      "pi_merged_legacy",
    );
    if (!statement) throw new Error("setup failed");
    await execute(statement.sql, statement.args);

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)).toEqual([
      {
        providerRefunded: false,
        reference: "pi_merged_legacy",
        sessionIds: [],
      },
    ]);
  });

  test("keeps legacy plaintext processed-payment references refundable", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "plain-ref@example.com",
      name: "Plain Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;

    await reserveSession("sess_plain_ref");
    await execute(
      `UPDATE processed_payments
          SET attendee_id = ?, payment_reference = ?, processed_at = ?
        WHERE payment_session_id = ?`,
      [
        attendeeId,
        "pi_plain_legacy",
        "2026-06-21T00:00:00.000Z",
        "sess_plain_ref",
      ],
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)?.map((entry) => entry.reference)).toEqual(
      ["pi_plain_legacy"],
    );
  });

  test("checks whether a single attendee has any refund reference", async () => {
    expect(
      await hasRefundPaymentReference(
        { id: 1234, payment_id: "pi_legacy" },
        await getTestPrivateKey(),
      ),
    ).toBe(true);
    expect(
      await hasRefundPaymentReference(
        { id: 5678, payment_id: "" },
        await getTestPrivateKey(),
      ),
    ).toBe(false);
  });

  test("marks returned processed-payment references", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "returned@example.com",
      name: "Returned",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await reserveSession("sess_returned");
    await finalizePaymentSession(
      "sess_returned",
      attendeeId,
      [],
      "pi_returned",
    );

    const before = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(before[0]!.providerRefunded).toBe(false);

    await markPaymentReferencesProviderRefunded(before);

    const after = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(after[0]!.providerRefunded).toBe(true);
  });
});
