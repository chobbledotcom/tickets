import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryOne } from "#db/client.ts";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import {
  getRefundPaymentReferences,
  type RefundPaymentReferenceSet,
} from "#db/payment-references.ts";
import { sql } from "#db/sql.ts";
import type { UntaggedPaymentReference } from "#payment/provider-reference.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { requireCompleteRefundReferences } from "#test-utils/payment-references.ts";
import {
  finalizeProcessedPayment,
  refundReferencesFor,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

const untagged = (reference: string): UntaggedPaymentReference => ({
  kind: "untagged",
  reference,
});

const indexOf = (sessionId: string): Promise<{ value: string } | null> =>
  queryOne<{ value: string }>(
    sql`SELECT payment_reference_index AS value
       FROM processed_payments
      WHERE payment_session_id = ${sessionId}`,
  );

/** One attendee on a fresh fifty-seat listing, booked for a single slot. */
const bookAttendeeId = async (email: string, name: string): Promise<number> =>
  bookedAttendee(
    await bookAttendee(await createTestListing({ maxAttendees: 50 }), {
      email,
      name,
    }),
  ).id;

const completeReferencesFor = (
  sets: ReadonlyMap<number, RefundPaymentReferenceSet>,
  attendeeId: number,
) => {
  const set = sets.get(attendeeId);
  if (set === undefined) throw new Error(`Attendee ${attendeeId} was omitted`);
  return requireCompleteRefundReferences(set, `Attendee ${attendeeId}`);
};

const expectLegacyReferenceUnavailable = async (
  attendeeId: number,
  sessionId: string,
): Promise<void> => {
  const references = await getRefundPaymentReferences(
    [{ currentPaymentId: "", id: attendeeId }],
    await getTestPrivateKey(),
  );

  expect(references.get(attendeeId)).toEqual({ kind: "legacy_unindexed" });
  expect(() => completeReferencesFor(references, attendeeId)).toThrow(
    `Attendee ${attendeeId} is unexpectedly unindexed`,
  );
  expect(await indexOf(sessionId)).toEqual({ value: "" });
};

describeWithEnv("db > payment reference storage", { db: true }, () => {
  test("returns an empty map for no attendees", async () => {
    expect(
      await getRefundPaymentReferences([], await getTestPrivateKey()),
    ).toEqual(new Map());
  });

  test("refuses PII payment ids missing from indexed rows", async () => {
    const firstId = await bookAttendeeId("refs1@example.com", "Refs One");
    const secondId = await bookAttendeeId("refs2@example.com", "Refs Two");
    const recorded = taggedPaymentReference("pi_recorded");

    await finalizeProcessedPayment("sess_refs_a", firstId, "", recorded);
    await finalizeProcessedPayment("sess_refs_b", firstId, "", recorded);

    const references = await getRefundPaymentReferences(
      [
        { currentPaymentId: "pi_legacy_ignored", id: firstId },
        { currentPaymentId: "pi_legacy_used", id: secondId },
        { currentPaymentId: "", id: 9999 },
      ],
      await getTestPrivateKey(),
    );

    expect(references.get(firstId)).toEqual({ kind: "legacy_unindexed" });
    expect(references.get(secondId)).toEqual({ kind: "legacy_unindexed" });
    expect(completeReferencesFor(references, 9999)).toEqual([]);
  });

  test("does not duplicate a legacy id already present on a tagged row", async () => {
    const attendeeId = await bookAttendeeId(
      "refs-duplicate@example.com",
      "Refs Duplicate",
    );

    await finalizeProcessedPayment(
      "sess_refs_duplicate",
      attendeeId,
      "",
      taggedPaymentReference("pi_duplicate"),
    );

    const references = await getRefundPaymentReferences(
      [{ currentPaymentId: "pi_duplicate", id: attendeeId }],
      await getTestPrivateKey(),
    );

    expect(
      completeReferencesFor(references, attendeeId).map(
        ({ kind, reference }) => ({
          kind,
          reference,
        }),
      ),
    ).toEqual([{ kind: "tagged", reference: "pi_duplicate" }]);
  });

  test("leaves an unindexed plaintext reference unavailable", async () => {
    const attendeeId = await bookAttendeeId(
      "plain-ref@example.com",
      "Plain Ref",
    );

    await execute(
      sql`INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference)
        VALUES (${"sess_plain_ref"}, ${attendeeId}, ${"2026-06-21T00:00:00.000Z"}, ${"pi_plain_legacy"})`,
    );

    await expectLegacyReferenceUnavailable(attendeeId, "sess_plain_ref");
  });

  test("rejects a durable index whose reference is still plaintext", async () => {
    const attendeeId = await bookAttendeeId(
      "indexed-plain-ref@example.com",
      "Indexed Plain Ref",
    );
    const payment = untagged("pi_plain_indexed");
    const sessionId = "sess_plain_indexed";

    await execute(
      sql`INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference,
           payment_reference_index)
        VALUES (${sessionId}, ${attendeeId}, ${"2026-06-21T00:00:00.000Z"}, ${payment.reference}, ${await paymentReferenceIndex(payment)})`,
    );

    await expect(
      refundReferencesFor(attendeeId, await getTestPrivateKey()),
    ).rejects.toThrow("processed_payments.payment_reference");
  });

  test("does not repair a row predating the provider-aware index", async () => {
    const attendeeId = await bookAttendeeId(
      "unindexed@example.com",
      "Unindexed",
    );
    const payment = taggedPaymentReference("pi_unindexed", "sumup");
    await finalizeProcessedPayment("sess_unindexed", attendeeId, "", payment);
    await execute(
      sql`UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ${"sess_unindexed"}`,
    );

    await expectLegacyReferenceUnavailable(attendeeId, "sess_unindexed");
  });

  test("refuses a stored row whose reference index does not match", async () => {
    const attendeeId = await bookAttendeeId(
      "mismatched-index@example.com",
      "Mismatched Index",
    );
    const sessionId = "sess_mismatched_index";
    await finalizeProcessedPayment(
      sessionId,
      attendeeId,
      "",
      taggedPaymentReference("pi_mismatched_index", "square"),
    );
    await execute(
      sql`UPDATE processed_payments
          SET payment_reference_index = ${"wrong-index"}
        WHERE payment_session_id = ${sessionId}`,
    );

    await expect(
      getRefundPaymentReferences(
        [{ currentPaymentId: "", id: attendeeId }],
        await getTestPrivateKey(),
      ),
    ).rejects.toThrow(
      /^Payment reference index does not match stored reference$/u,
    );
    expect(await indexOf(sessionId)).toEqual({ value: "wrong-index" });
  });
});
