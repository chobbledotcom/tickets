// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { execute, queryOne } from "#db/client.ts";
import {
  countLegacyPaymentReferences,
  rebuildLegacyPaymentReferences,
} from "#db/payment-reference-rebuild.ts";
import { getRefundPaymentReferences } from "#db/payment-references.ts";
import { getRefundAllSummary } from "#db/refund-all-candidates.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookLegacyPaidAttendee,
  seedHistoricalProcessedPayment,
} from "#test-utils/historical-payment-references.ts";
import {
  expectProcessedPaymentReference,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

// jscpd:ignore-end

const provenancePointerOf = async (
  attendeeId: number,
): Promise<string | null> => {
  const row = await queryOne<{ pii_payment_session_id: string | null }>(
    "SELECT pii_payment_session_id FROM attendees WHERE id = ?",
    [attendeeId],
  );
  return row?.pii_payment_session_id ?? null;
};

describeWithEnv("db > legacy payment reference rebuild", { db: true }, () => {
  test("a legacy payment is refused before the rebuild and refundable after", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_old_release",
      "pi_old_release",
    );
    const privateKey = await getTestPrivateKey();

    const before = await getRefundPaymentReferences(
      [{ currentPaymentId: attendee.payment_id, id: attendee.id }],
      privateKey,
    );
    expect(before.get(attendee.id)).toEqual({ kind: "legacy_unindexed" });
    expect(await countLegacyPaymentReferences()).toBe(1);

    expect(await rebuildLegacyPaymentReferences("stripe", privateKey)).toEqual({
      rebuilt: 1,
      remaining: 0,
    });

    const references = await getRefundPaymentReferences(
      [{ currentPaymentId: attendee.payment_id, id: attendee.id }],
      privateKey,
    );
    expect(references.get(attendee.id)).toEqual({
      kind: "complete",
      references: [
        expect.objectContaining({
          kind: "tagged",
          provider: "stripe",
          reference: "pi_old_release",
        }),
      ],
    });
    await expectProcessedPaymentReference(
      attendee.id,
      "sess_old_release",
      taggedPaymentReference("pi_old_release"),
      privateKey,
    );
  });

  test("the rebuild qualifies the attendee provenance pointer and unblocks Refund All", async () => {
    const { attendee, listing } = await bookLegacyPaidAttendee(
      "sess_provenance",
      "pi_provenance",
    );
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: "legacy_unindexed",
      total: 1,
    });

    await rebuildLegacyPaymentReferences("stripe", await getTestPrivateKey());

    expect(await provenancePointerOf(attendee.id)).toBe("sess_provenance");
    expect(await getRefundAllSummary(listing.id)).toEqual({
      blockedBy: null,
      total: 1,
    });
  });

  test("a replayed rebuild changes nothing", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_replay",
      "pi_replay",
    );
    const privateKey = await getTestPrivateKey();
    await rebuildLegacyPaymentReferences("stripe", privateKey);
    const storedIndex = await queryOne<{ payment_reference_index: string }>(
      "SELECT payment_reference_index FROM processed_payments WHERE payment_session_id = ?",
      ["sess_replay"],
    );

    expect(await rebuildLegacyPaymentReferences("stripe", privateKey)).toEqual({
      rebuilt: 0,
      remaining: 0,
    });
    expect(await countLegacyPaymentReferences()).toBe(0);
    expect(
      await queryOne<{ payment_reference_index: string }>(
        "SELECT payment_reference_index FROM processed_payments WHERE payment_session_id = ?",
        ["sess_replay"],
      ),
    ).toEqual(storedIndex);
    expect(await provenancePointerOf(attendee.id)).toBe("sess_replay");
  });

  test("a kept provider tag and a kept provenance pointer survive the rebuild", async () => {
    const listing = await createTestListing();
    const tagged = bookedAttendee(
      await bookAttendee(listing, {
        email: "tagged-blank@example.com",
        name: "Tagged Blank",
        paymentId: "pi_tagged_blank",
      }),
    );
    await finalizeProcessedPayment("sess_tagged_blank", tagged.id, "", {
      kind: "tagged",
      provider: "square",
      reference: "pi_tagged_blank",
    });
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_tagged_blank"],
    );

    const pointed = bookedAttendee(
      await bookAttendee(listing, {
        email: "pointed@example.com",
        name: "Pointed",
        paymentId: "pi_pointed",
      }),
    );
    await seedHistoricalProcessedPayment(
      "sess_pointed",
      pointed.id,
      "pi_pointed",
    );
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_pointed"],
    );
    await execute(
      "UPDATE attendees SET pii_payment_session_id = 'sess_pointed' WHERE id = ?",
      [pointed.id],
    );

    const privateKey = await getTestPrivateKey();
    expect(await rebuildLegacyPaymentReferences("stripe", privateKey)).toEqual({
      rebuilt: 2,
      remaining: 0,
    });

    await expectProcessedPaymentReference(
      tagged.id,
      "sess_tagged_blank",
      taggedPaymentReference("pi_tagged_blank", "square"),
      privateKey,
    );
    expect(await provenancePointerOf(pointed.id)).toBe("sess_pointed");
  });

  test("an attendee with several legacy rows points at the oldest one", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_deposit",
      "pi_deposit",
    );
    await seedHistoricalProcessedPayment(
      "sess_balance",
      attendee.id,
      "pi_balance",
    );
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_balance"],
    );
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2026-07-01T00:00:00.000Z", "sess_deposit"],
    );
    await execute(
      "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
      ["2026-07-02T00:00:00.000Z", "sess_balance"],
    );

    expect(
      await rebuildLegacyPaymentReferences("stripe", await getTestPrivateKey()),
    ).toEqual({ rebuilt: 2, remaining: 0 });
    expect(await provenancePointerOf(attendee.id)).toBe("sess_deposit");
  });

  test("a row the owner key cannot open fails the run and writes nothing", async () => {
    const good = await bookLegacyPaidAttendee("sess_good_row", "pi_good_row");
    const broken = await bookLegacyPaidAttendee(
      "sess_broken_row",
      "pi_broken_row",
    );
    await execute(
      "UPDATE processed_payments SET payment_reference = ? WHERE payment_session_id = ?",
      [await encrypt("stored under the wrong key"), "sess_broken_row"],
    );

    await expect(
      rebuildLegacyPaymentReferences("stripe", await getTestPrivateKey()),
    ).rejects.toThrow("is not owner-key encrypted");

    expect(await countLegacyPaymentReferences()).toBe(2);
    expect(await provenancePointerOf(good.attendee.id)).toBeNull();
    expect(await provenancePointerOf(broken.attendee.id)).toBeNull();
  });

  test("the count names only attendee-bearing rows that still wait", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_counted",
      "pi_counted",
    );
    await seedHistoricalProcessedPayment(
      "sess_unresolved",
      attendee.id,
      "pi_unresolved",
    );
    await execute(
      "UPDATE processed_payments SET attendee_id = NULL WHERE payment_session_id = ?",
      ["sess_unresolved"],
    );
    await execute(
      "UPDATE processed_payments SET payment_reference = '' WHERE payment_session_id = ?",
      ["sess_unresolved"],
    );

    expect(await countLegacyPaymentReferences()).toBe(1);
    await rebuildLegacyPaymentReferences("stripe", await getTestPrivateKey());
    expect(await countLegacyPaymentReferences()).toBe(0);
  });
});
