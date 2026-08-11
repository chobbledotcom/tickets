import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  paymentReferenceIndex,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import {
  getRefundPaymentReferences,
  legacyMergePaymentReferenceStatement,
} from "#shared/db/payment-references.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { UntaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  finalizeProcessedPayment,
  readReference,
  refundReferencesFor,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

const untagged = (reference: string): UntaggedPaymentReference => ({
  kind: "untagged",
  reference,
});

const indexOf = (sessionId: string): Promise<{ value: string } | null> =>
  queryOne<{ value: string }>(
    `SELECT payment_reference_index AS value
       FROM processed_payments
      WHERE payment_session_id = ?`,
    [sessionId],
  );

describeWithEnv("db > payment reference storage", { db: true }, () => {
  test("stores a tagged reference encrypted with its provider-aware index", async () => {
    const payment = taggedPaymentReference("pi_secret", "square");
    const stored = await storePaymentReference(payment);

    expect(stored.encrypted).not.toContain(payment.reference);
    expect(stored.index).toBe(await paymentReferenceIndex(payment));
  });

  test("returns an empty map for no attendees", async () => {
    expect(
      await getRefundPaymentReferences([], await getTestPrivateKey()),
    ).toEqual(new Map());
  });

  test("includes a legacy payment id beside tagged payment rows", async () => {
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
    const recorded = taggedPaymentReference("pi_recorded");

    await finalizeProcessedPayment("sess_refs_a", firstId, "", recorded);
    await finalizeProcessedPayment("sess_refs_b", firstId, "", recorded);

    const references = await getRefundPaymentReferences(
      [
        { id: firstId, payment_id: "pi_legacy_ignored" },
        { id: secondId, payment_id: "pi_legacy_used" },
        { id: 9999, payment_id: "" },
      ],
      await getTestPrivateKey(),
    );

    const firstRefs = references.get(firstId)!;
    expect(
      firstRefs.map(({ kind, reference }) => ({ kind, reference })),
    ).toEqual([
      { kind: "tagged", reference: "pi_recorded" },
      { kind: "untagged", reference: "pi_legacy_ignored" },
    ]);
    expect(firstRefs.at(-1)).toEqual({
      heldRowSessionIds: [],
      index: await paymentReferenceIndex(untagged("pi_legacy_ignored")),
      kind: "untagged",
      reference: "pi_legacy_ignored",
      refundState: "unknown",
      rowSessionIds: [],
      sessionIds: [],
    });
    expect(references.get(secondId)?.map((entry) => entry.reference)).toEqual([
      "pi_legacy_used",
    ]);
    expect(references.get(9999)).toEqual([]);
  });

  test("does not duplicate a legacy id already present on a tagged row", async () => {
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
      taggedPaymentReference("pi_duplicate"),
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "pi_duplicate" }],
      await getTestPrivateKey(),
    );

    expect(
      references.get(attendeeId)?.map(({ kind, reference }) => ({
        kind,
        reference,
      })),
    ).toEqual([{ kind: "tagged", reference: "pi_duplicate" }]);
  });

  test("reads merged legacy ids as session-less untagged references", async () => {
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

    expect(
      await refundReferencesFor(attendeeId, await getTestPrivateKey()),
    ).toEqual([
      await readReference(untagged("pi_merged_legacy"), {
        refundState: "unknown",
        rowSessionIds: ["legacy-merge:12345"],
        sessionIds: [],
      }),
    ]);
  });

  test("indexes a merged legacy payment so a claim can see it", async () => {
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

    expect(await indexOf("legacy-merge:54321")).toEqual({
      value: await paymentReferenceIndex(untagged("pi_merged_indexed")),
    });
  });

  test("keeps a legacy plaintext reference refundable", async () => {
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

    expect(
      references.get(attendeeId)?.map(({ kind, reference }) => ({
        kind,
        reference,
      })),
    ).toEqual([{ kind: "untagged", reference: "pi_plain_legacy" }]);
  });

  test("fills the provider-aware index on a row predating the column", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "unindexed@example.com",
      name: "Unindexed",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const payment = taggedPaymentReference("pi_unindexed", "sumup");
    await finalizeProcessedPayment("sess_unindexed", attendeeId, "", payment);
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_unindexed"],
    );

    const references = await getRefundPaymentReferences(
      [{ id: attendeeId, payment_id: "" }],
      await getTestPrivateKey(),
    );

    const expected = await paymentReferenceIndex(payment);
    expect(references.get(attendeeId)?.map((entry) => entry.index)).toEqual([
      expected,
    ]);
    expect(await indexOf("sess_unindexed")).toEqual({ value: expected });
  });
});
