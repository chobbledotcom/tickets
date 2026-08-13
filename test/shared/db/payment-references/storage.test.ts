import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt, ENCRYPTION_PREFIX } from "#shared/crypto/encryption.ts";
import { HYBRID_PREFIX } from "#shared/crypto/keys.ts";
import type { EnvKeyEncrypted } from "#shared/crypto/sealed.ts";
import { execute, queryOne } from "#shared/db/client.ts";
import {
  loadPaymentReference,
  paymentReferenceIndex,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import {
  getRefundPaymentReferences,
  legacyMergePaymentReferenceStatement,
  type RefundPaymentReferenceSet,
} from "#shared/db/payment-references.ts";
import type { UntaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { requireCompleteRefundReferences } from "#test-utils/payment-references.ts";
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
  test("stores a tagged reference encrypted with its provider-aware index", async () => {
    const payment = taggedPaymentReference("pi_secret", "square");
    const stored = await storePaymentReference(payment);

    expect(stored.encrypted).not.toContain(payment.reference);
    expect(stored.encrypted.startsWith(HYBRID_PREFIX)).toBe(true);
    expect(stored.encrypted.startsWith(ENCRYPTION_PREFIX)).toBe(false);
    await expect(
      decrypt(stored.encrypted as unknown as EnvKeyEncrypted),
    ).rejects.toThrow();
    expect(stored.index).toBe(await paymentReferenceIndex(payment));
    expect(
      await loadPaymentReference(
        stored.encrypted,
        await getTestPrivateKey(),
        "stored test payment reference",
      ),
    ).toEqual(payment);
  });

  test("returns an empty map for no attendees", async () => {
    expect(
      await getRefundPaymentReferences([], await getTestPrivateKey()),
    ).toEqual(new Map());
  });

  test("refuses PII payment ids missing from indexed rows", async () => {
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

  test("does not anchor a merged payment already held by a checkout row", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const target = await bookAttendee(listing, {
      email: "merge-anchor-target@example.com",
      name: "Merge Anchor Target",
    });
    const source = await bookAttendee(listing, {
      email: "merge-anchor-source@example.com",
      name: "Merge Anchor Source",
    });
    if (!target.success || !source.success) throw new Error("setup failed");
    const [targetAttendee] = target.attendees;
    const [sourceAttendee] = source.attendees;
    if (targetAttendee === undefined || sourceAttendee === undefined) {
      throw new Error("setup created no attendees");
    }
    const targetId = targetAttendee.id;
    const sourceId = sourceAttendee.id;
    const reference = "pi_merge_current";
    await finalizeProcessedPayment(
      "sess_merge_current",
      sourceId,
      "",
      taggedPaymentReference(reference),
    );

    const statement = await legacyMergePaymentReferenceStatement(
      targetId,
      sourceId,
      reference,
    );
    if (!statement) throw new Error("setup failed");
    await execute(statement.sql, statement.args);

    expect(await indexOf(`legacy-merge:${sourceId}`)).toBeNull();
  });

  test("leaves an unindexed plaintext reference unavailable", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "plain-ref@example.com",
      name: "Plain Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;

    await execute(
      `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference)
        VALUES (?, ?, ?, ?)`,
      [
        "sess_plain_ref",
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        "pi_plain_legacy",
      ],
    );

    await expectLegacyReferenceUnavailable(attendeeId, "sess_plain_ref");
  });

  test("rejects a durable index whose reference is still plaintext", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "indexed-plain-ref@example.com",
      name: "Indexed Plain Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const payment = untagged("pi_plain_indexed");
    const sessionId = "sess_plain_indexed";

    await execute(
      `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference,
           payment_reference_index)
        VALUES (?, ?, ?, ?, ?)`,
      [
        sessionId,
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        payment.reference,
        await paymentReferenceIndex(payment),
      ],
    );

    await expect(
      refundReferencesFor(attendeeId, await getTestPrivateKey()),
    ).rejects.toThrow("processed_payments.payment_reference");
  });

  test("does not repair a row predating the provider-aware index", async () => {
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

    await expectLegacyReferenceUnavailable(attendeeId, "sess_unindexed");
  });

  test("refuses a stored row whose reference index does not match", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "mismatched-index@example.com",
      name: "Mismatched Index",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const sessionId = "sess_mismatched_index";
    await finalizeProcessedPayment(
      sessionId,
      attendeeId,
      "",
      taggedPaymentReference("pi_mismatched_index", "square"),
    );
    await execute(
      `UPDATE processed_payments
          SET payment_reference_index = ?
        WHERE payment_session_id = ?`,
      ["wrong-index", sessionId],
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
