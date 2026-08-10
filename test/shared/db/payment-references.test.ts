import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  encryptPaymentReference,
  getAttendeeIdsWithPaymentReference,
  getRefundPaymentReferences,
  hasAnyPaymentReference,
  hasRefundPaymentReference,
  legacyMergePaymentReferenceStatement,
  markPaymentReferencesProviderRefunded,
  paymentReferenceIndex,
} from "#shared/db/payment-references.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

const indexOf = (sessionId: string): Promise<{ v: string } | null> =>
  queryOne<{ v: string }>(
    "SELECT payment_reference_index AS v FROM processed_payments WHERE payment_session_id = ?",
    [sessionId],
  );

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

    await finalizeProcessedPayment("sess_refs_a", firstId, "", "pi_recorded");
    await finalizeProcessedPayment("sess_refs_b", firstId, "", "pi_recorded");

    const references = await getRefundPaymentReferences(
      [
        { id: firstId, payment_id: "pi_legacy_ignored" },
        { id: secondId, payment_id: "pi_legacy_used" },
        { id: 9999, payment_id: "" },
      ],
      await getTestPrivateKey(),
    );

    const firstRefs = references.get(firstId)!;
    expect(firstRefs.map((entry) => entry.reference)).toEqual([
      "pi_recorded",
      "pi_legacy_ignored",
    ]);
    // The legacy payment_id falls through `legacyReference`, which marks an
    // unobserved refund "unknown" — distinguish that from "completed".
    expect(firstRefs.at(-1)).toEqual({
      index: await paymentReferenceIndex("pi_legacy_ignored"),
      reference: "pi_legacy_ignored",
      refundState: "unknown",
      sessionIds: [],
    });
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

    await finalizeProcessedPayment(
      "sess_refs_duplicate",
      attendeeId,
      "",
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
        index: await paymentReferenceIndex("pi_merged_legacy"),
        reference: "pi_merged_legacy",
        refundState: "unknown",
        sessionIds: [],
      },
    ]);
  });

  test("indexes a merged legacy payment so a claim can see the money", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "merged-legacy-index@example.com",
      name: "Merged Legacy Index",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const statement = await legacyMergePaymentReferenceStatement(
      attendeeId,
      54321,
      "pi_merged_indexed",
    );
    if (!statement) throw new Error("setup failed");
    await execute(statement.sql, statement.args);

    // A refund claim asks "is another row already working on this same money?"
    // by this column alone. Without it the inherited charge is invisible, and
    // two attendees carrying it could each send a payout against it.
    expect(await indexOf("legacy-merge:54321")).toEqual({
      v: await paymentReferenceIndex("pi_merged_indexed"),
    });
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

  test("fills in the index a row predating the column never got", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "unindexed@example.com",
      name: "Unindexed",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await finalizeProcessedPayment(
      "sess_unindexed",
      attendeeId,
      "",
      "pi_unindexed",
    );
    // As the row stood before the index column existed. Nothing without the
    // owner's key could ever fill it in — the reference it is derived from is
    // encrypted — so the first authenticated read has to.
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_unindexed"],
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    const expected = await paymentReferenceIndex("pi_unindexed");
    // Handed to this caller, so its own claim can see the money...
    expect(references.get(attendeeId)?.map((entry) => entry.index)).toEqual([
      expected,
    ]);
    // ...and written back, so every later claim can too.
    expect(await indexOf("sess_unindexed")).toEqual({ v: expected });
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
    await finalizeProcessedPayment(
      "sess_returned",
      attendeeId,
      "",
      "pi_returned",
    );

    const before = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(before[0]!.refundState).toBe("none");

    await markPaymentReferencesProviderRefunded(before);

    const after = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(after[0]!.refundState).toBe("completed");
  });

  test("legacyMergePaymentReferenceStatement returns null for empty source payment id", async () => {
    expect(await legacyMergePaymentReferenceStatement(1, 2, "")).toBe(null);
  });

  test("getAttendeeIdsWithPaymentReference skips attendees with empty payment_id and no processed-payment row", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "hasref@example.com",
      name: "Has Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await finalizeProcessedPayment(
      "sess_has_ref",
      attendeeId,
      "",
      "pi_has_ref",
    );

    // An attendee with empty payment_id AND a processed_payments row still
    // surfaces via the processed-payments lookup, since that path doesn't
    // depend on the legacy payment_id filter and uses the default suffix
    // branch of queryProcessedReferences.
    const ids = await getAttendeeIdsWithPaymentReference([
      { id: attendeeId, payment_id: "" },
      { id: 9999, payment_id: "" },
    ]);
    expect(ids.has(attendeeId)).toBe(true);
    expect(ids.has(9999)).toBe(false);
    expect(ids).toBeInstanceOf(Set);
  });

  test("merges same-reference rows in stable processing order", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "shared-ref@example.com",
      name: "Shared Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const storedReference = await encryptPaymentReference("pi_shared");
    await execute(
      `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference)
        VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)`,
      [
        "sess_shared_a_middle",
        attendeeId,
        "2026-06-22T00:00:00.000Z",
        storedReference,
        "sess_shared_d_earlier",
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        storedReference,
        "sess_shared_b_earlier",
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        storedReference,
        "sess_shared_c_later",
        attendeeId,
        "2026-06-23T00:00:00.000Z",
        storedReference,
      ],
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)).toEqual([
      {
        index: await paymentReferenceIndex("pi_shared"),
        reference: "pi_shared",
        refundState: "none",
        sessionIds: [
          "sess_shared_b_earlier",
          "sess_shared_d_earlier",
          "sess_shared_a_middle",
          "sess_shared_c_later",
        ],
      },
    ]);
  });

  test("merges same-reference rows keeping the true refund flag from an earlier row", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "shared-refunded@example.com",
      name: "Shared Refunded",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await finalizeProcessedPayment(
      "sess_refunded_a",
      attendeeId,
      "",
      "pi_shared_refunded",
    );
    await finalizeProcessedPayment(
      "sess_refunded_b",
      attendeeId,
      "",
      "pi_shared_refunded",
    );
    await markPaymentReferencesProviderRefunded([
      {
        index: await paymentReferenceIndex("pi_shared_refunded"),
        reference: "pi_shared_refunded",
        refundState: "none",
        sessionIds: ["sess_refunded_a"],
      },
    ]);

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)).toEqual([
      {
        index: await paymentReferenceIndex("pi_shared_refunded"),
        reference: "pi_shared_refunded",
        // Ordered by processed_at; both sessions carried this reference, so
        // both session ids remain attached after the merge.
        refundState: "completed",
        sessionIds: ["sess_refunded_a", "sess_refunded_b"],
      },
    ]);
  });

  test("hasAnyPaymentReference treats an attendee with empty payment_id and no processed-payment row as having no reference", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "norref@example.com",
      name: "No Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;

    expect(
      await hasAnyPaymentReference({ id: attendeeId, payment_id: "" }),
    ).toBe(false);
    expect(
      await hasAnyPaymentReference({
        id: attendeeId,
        payment_id: "pi_legacy_present",
      }),
    ).toBe(true);
  });
});
