import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { storePaymentReference } from "#shared/db/payment-reference-store.ts";
import {
  getAttendeeIdsWithPaymentReference,
  getRefundPaymentReferences,
  hasAnyPaymentReference,
  hasRefundPaymentReference,
  legacyMergePaymentReferenceStatement,
  markPaymentReferencesProviderRefunded,
  stillWithTheProvider,
} from "#shared/db/payment-references.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import type { RefundState } from "#shared/payment/refund-state.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { refundReference } from "#test-utils/payment-state.ts";
import {
  finalizeProcessedPayment,
  readReference,
  refundReferencesFor,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

describeWithEnv("db > payment references", { db: true }, () => {
  test("PII-only payment ids are not refund references", async () => {
    expect(
      await hasRefundPaymentReference(
        { id: 1234, payment_id: "pi_legacy" },
        await getTestPrivateKey(),
      ),
    ).toBe(false);
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
      taggedPaymentReference("pi_returned"),
    );

    const before = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(before[0]!.kind).toBe("tagged");
    expect(before[0]!.refundState).toBe("none");

    await markPaymentReferencesProviderRefunded(before);

    const after = (
      await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      )
    ).get(attendeeId)!;
    expect(after[0]!.kind).toBe("tagged");
    expect(after[0]!.refundState).toBe("completed");
  });

  test("a legacy merge with no payment id needs no statement", async () => {
    expect(await legacyMergePaymentReferenceStatement(1, 2, "")).toBe(null);
  });

  test("finds processed references when the legacy payment id is empty", async () => {
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
      taggedPaymentReference("pi_has_ref"),
    );

    const ids = await getAttendeeIdsWithPaymentReference([
      { id: attendeeId, payment_id: "" },
      { id: 9999, payment_id: "" },
    ]);
    expect(ids.has(attendeeId)).toBe(true);
    expect(ids.has(9999)).toBe(false);
    expect(ids).toBeInstanceOf(Set);
  });

  test("merges tagged rows in stable processing order", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "shared-ref@example.com",
      name: "Shared Ref",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const payment = taggedPaymentReference("pi_shared", "square");
    const stored = await storePaymentReference(payment);
    await execute(
      `INSERT INTO processed_payments
          (payment_session_id, attendee_id, processed_at, payment_reference,
           payment_reference_index)
        VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?),
               (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
      [
        "sess_shared_a_middle",
        attendeeId,
        "2026-06-22T00:00:00.000Z",
        stored.encrypted,
        stored.index,
        "sess_shared_d_earlier",
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        stored.encrypted,
        stored.index,
        "sess_shared_b_earlier",
        attendeeId,
        "2026-06-21T00:00:00.000Z",
        stored.encrypted,
        stored.index,
        "sess_shared_c_later",
        attendeeId,
        "2026-06-23T00:00:00.000Z",
        stored.encrypted,
        stored.index,
      ],
    );

    const inProcessedOrder: [string, ...string[]] = [
      "sess_shared_b_earlier",
      "sess_shared_d_earlier",
      "sess_shared_a_middle",
      "sess_shared_c_later",
    ];

    expect(
      await refundReferencesFor(attendeeId, await getTestPrivateKey()),
    ).toEqual([
      await readReference(payment, {
        rowSessionIds: inProcessedOrder,
        sessionIds: inProcessedOrder,
      }),
    ]);
  });

  test("merges tagged rows keeping an earlier row's refund flag", async () => {
    const listing = await createTestListing({ maxAttendees: 50 });
    const created = await bookAttendee(listing, {
      email: "shared-refunded@example.com",
      name: "Shared Refunded",
    });
    if (!created.success) throw new Error("setup failed");
    const attendeeId = created.attendees[0]!.id;
    const payment = taggedPaymentReference("pi_shared_refunded");
    await finalizeProcessedPayment("sess_refunded_a", attendeeId, "", payment);
    await finalizeProcessedPayment("sess_refunded_b", attendeeId, "", payment);
    await markPaymentReferencesProviderRefunded([
      await readReference(payment, {
        rowSessionIds: ["sess_refunded_a"],
        sessionIds: ["sess_refunded_a"],
      }),
    ]);

    expect(
      await refundReferencesFor(attendeeId, await getTestPrivateKey()),
    ).toEqual([
      await readReference(payment, {
        refundState: "completed",
        rowSessionIds: ["sess_refunded_a", "sess_refunded_b"],
        sessionIds: ["sess_refunded_a", "sess_refunded_b"],
      }),
    ]);
  });

  test("finds no reference when neither storage path has one", async () => {
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

describeWithEnv(
  "db > payment references > rows with nothing to refund",
  { db: true },
  () => {
    test("passes over a row holding no reference", async () => {
      const listing = await createTestListing({ maxAttendees: 50 });
      const created = await bookAttendee(listing, {
        email: "no-reference@example.com",
        name: "No Reference",
      });
      if (!created.success) throw new Error("setup failed");
      const attendeeId = created.attendees[0]!.id;

      await reserveSession("sess_no_reference");
      await execute(
        `UPDATE processed_payments
          SET attendee_id = ?, payment_reference = '', processed_at = ?
        WHERE payment_session_id = ?`,
        [attendeeId, "2026-06-21T00:00:00.000Z", "sess_no_reference"],
      );

      const references = await getRefundPaymentReferences(
        [{ id: attendeeId, payment_id: "" }],
        await getTestPrivateKey(),
      );

      expect(references.get(attendeeId)).toEqual([]);
    });
  },
);

describe("db > payment references > still with the provider", () => {
  const withStates = (...states: RefundState[]) =>
    states.map((refundState, index) =>
      refundReference(`pi_${index}`, { refundState }),
    );

  test("a watched charge not seen back is still out", () => {
    expect(stillWithTheProvider(withStates("none"))).toBe(true);
  });

  test("a charge seen back is settled", () => {
    expect(stillWithTheProvider(withStates("completed"))).toBe(false);
  });

  test("an unknown legacy charge beside a returned one keeps retry open", () => {
    expect(stillWithTheProvider(withStates("completed", "unknown"))).toBe(true);
  });

  test("an unknown legacy charge on its own stays settled", () => {
    expect(stillWithTheProvider(withStates("unknown"))).toBe(false);
  });

  test("nothing to refund is not still with the provider", () => {
    expect(stillWithTheProvider([])).toBe(false);
  });
});
