import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import {
  encryptPaymentReference,
  getAttendeeIdsWithPaymentReference,
  getRefundPaymentReferences,
  hasAnyPaymentReference,
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

    const firstRefs = references.get(firstId)!;
    expect(firstRefs.map((entry) => entry.reference)).toEqual([
      "pi_recorded",
      "pi_legacy_ignored",
    ]);
    // The legacy payment_id falls through `legacyReference`, which sets
    // providerRefunded:false — distinguish false from true on a legacy entry.
    expect(firstRefs.at(-1)).toEqual({
      providerRefunded: false,
      reference: "pi_legacy_ignored",
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

  test("legacyMergePaymentReferenceStatement returns null for empty source payment id", async () => {
    expect(
      await legacyMergePaymentReferenceStatement(1, 2, ""),
    ).toBe(null);
  });

  test("getAttendeeIdsWithPaymentReference skips attendees with empty payment_id and no processed-payment row", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "hasref@example.com",
      name: "Has Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await reserveSession("sess_has_ref");
    await finalizePaymentSession("sess_has_ref", attendeeId, [], "pi_has_ref");

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

  test("merges same-reference rows keeping every session id and the merged false refund flag", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "shared-ref@example.com",
      name: "Shared Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    await reserveSession("sess_shared_a");
    await finalizePaymentSession(
      "sess_shared_a",
      attendeeId,
      [],
      "pi_shared",
    );
    await reserveSession("sess_shared_b");
    await finalizePaymentSession(
      "sess_shared_b",
      attendeeId,
      [],
      "pi_shared",
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)).toEqual([
      {
        providerRefunded: false,
        reference: "pi_shared",
        sessionIds: ["sess_shared_a", "sess_shared_b"],
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
    await reserveSession("sess_refunded_a");
    await finalizePaymentSession(
      "sess_refunded_a",
      attendeeId,
      [],
      "pi_shared_refunded",
    );
    await reserveSession("sess_refunded_b");
    await finalizePaymentSession(
      "sess_refunded_b",
      attendeeId,
      [],
      "pi_shared_refunded",
    );
    await markPaymentReferencesProviderRefunded([
      {
        providerRefunded: false,
        reference: "pi_shared_refunded",
        sessionIds: ["sess_refunded_a"],
      },
    ]);

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    expect(references.get(attendeeId)).toEqual([
      {
        providerRefunded: true,
        reference: "pi_shared_refunded",
        // Ordered by processed_at; both sessions carried this reference, so
        // both session ids remain attached after the merge.
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
