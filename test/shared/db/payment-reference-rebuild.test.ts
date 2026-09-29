// jscpd:ignore-start -- imports
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { encrypt } from "#crypto/encryption.ts";
import { execute, queryOne } from "#db/client.ts";
import {
  countLegacyPaymentReferences,
  legacyPaymentReferencePage,
  rebuildLegacyPaymentReferences,
} from "#db/payment-reference-rebuild.ts";
import { getRefundPaymentReferences } from "#db/payment-references.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookAttendee,
  bookedAttendee,
} from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  bookLegacyPaidAttendee,
  provenancePointerOf,
  rebuildStatingProviderForEveryRow,
  seedHistoricalProcessedPayment,
  statedForEveryRow,
} from "#test-utils/historical-payment-references.ts";
import {
  expectProcessedPaymentReference,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

// jscpd:ignore-end

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
    expect(
      await rebuildLegacyPaymentReferences(
        await statedForEveryRow("stripe"),
        privateKey,
      ),
    ).toEqual({
      rebuilt: 1,
      remaining: 0,
      unqualified: 0,
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

  test("a replayed rebuild changes nothing", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_replay",
      "pi_replay",
    );
    await rebuildStatingProviderForEveryRow("stripe");
    const storedIndex = await queryOne<{ payment_reference_index: string }>(
      "SELECT payment_reference_index FROM processed_payments WHERE payment_session_id = ?",
      ["sess_replay"],
    );

    expect(await rebuildStatingProviderForEveryRow("stripe")).toEqual({
      rebuilt: 0,
      remaining: 0,
      unqualified: 0,
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
    expect(
      await rebuildLegacyPaymentReferences(
        await statedForEveryRow("stripe"),
        privateKey,
      ),
    ).toEqual({
      rebuilt: 2,
      remaining: 0,
      unqualified: 0,
    });

    await expectProcessedPaymentReference(
      tagged.id,
      "sess_tagged_blank",
      taggedPaymentReference("pi_tagged_blank", "square"),
      privateKey,
    );
    expect(await provenancePointerOf(pointed.id)).toBe("sess_pointed");
  });

  test("each row takes the provider the owner stated for it", async () => {
    const stripeRow = await bookLegacyPaidAttendee(
      "sess_mixed_st",
      "pi_mixed_st",
    );
    const squareRow = await bookLegacyPaidAttendee(
      "sess_mixed_sq",
      "pi_mixed_sq",
    );
    const privateKey = await getTestPrivateKey();

    expect(
      await rebuildLegacyPaymentReferences(
        new Map([
          ["sess_mixed_st", "stripe"],
          ["sess_mixed_sq", "square"],
        ]),
        privateKey,
      ),
    ).toEqual({ rebuilt: 2, remaining: 0, unqualified: 0 });
    await expectProcessedPaymentReference(
      stripeRow.attendee.id,
      "sess_mixed_st",
      taggedPaymentReference("pi_mixed_st", "stripe"),
      privateKey,
    );
    await expectProcessedPaymentReference(
      squareRow.attendee.id,
      "sess_mixed_sq",
      taggedPaymentReference("pi_mixed_sq", "square"),
      privateKey,
    );
  });

  test("an untagged row with no stated provider fails the run", async () => {
    const { attendee } = await bookLegacyPaidAttendee(
      "sess_unstated",
      "pi_unstated",
    );

    await expect(
      rebuildLegacyPaymentReferences(new Map(), await getTestPrivateKey()),
    ).rejects.toThrow("no stated provider for payment session sess_unstated");

    expect(await countLegacyPaymentReferences()).toBe(1);
    expect(await provenancePointerOf(attendee.id)).toBeNull();
  });

  test("a row that already names its provider needs no stated choice", async () => {
    const listing = await createTestListing();
    const tagged = bookedAttendee(
      await bookAttendee(listing, {
        email: "kept-tag@example.com",
        name: "Kept Tag",
        paymentId: "pi_kept_tag",
      }),
    );
    await finalizeProcessedPayment("sess_kept_tag", tagged.id, "", {
      kind: "tagged",
      provider: "square",
      reference: "pi_kept_tag",
    });
    await execute(
      "UPDATE processed_payments SET payment_reference_index = '' WHERE payment_session_id = ?",
      ["sess_kept_tag"],
    );
    const privateKey = await getTestPrivateKey();
    expect(await legacyPaymentReferencePage(privateKey)).toEqual([
      expect.objectContaining({
        alreadyTagged: true,
        paymentSessionId: "sess_kept_tag",
      }),
    ]);

    expect(await rebuildLegacyPaymentReferences(new Map(), privateKey)).toEqual(
      { rebuilt: 1, remaining: 0, unqualified: 0 },
    );
    await expectProcessedPaymentReference(
      tagged.id,
      "sess_kept_tag",
      taggedPaymentReference("pi_kept_tag", "square"),
      privateKey,
    );
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
      rebuildLegacyPaymentReferences(
        new Map([
          ["sess_broken_row", "stripe"],
          ["sess_good_row", "stripe"],
        ]),
        await getTestPrivateKey(),
      ),
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
    await rebuildStatingProviderForEveryRow("stripe");
    expect(await countLegacyPaymentReferences()).toBe(0);
  });
});
