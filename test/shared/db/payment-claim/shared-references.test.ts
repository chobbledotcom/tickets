import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { anchorSessionId } from "#shared/db/payment-anchor/session.ts";
import {
  paymentReferenceIndex,
  type StoredPaymentReference,
  storePaymentReference,
} from "#shared/db/payment-reference-store.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  claimCurrentAttendeeRows,
  heldSessionIds,
} from "#test-utils/payment-claim.ts";
import {
  bookedWithPayment,
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

const repointPaymentRow = async (
  sessionId: string,
  stored: StoredPaymentReference,
): Promise<void> => {
  await execute(
    `UPDATE processed_payments
        SET payment_reference = ?, payment_reference_index = ?
      WHERE payment_session_id = ?`,
    [stored.encrypted, stored.index, sessionId],
  );
};

const sharedSessions = (claim: {
  shared: ReadonlyMap<string, readonly { sessionId: string }[]>;
}): string[] =>
  [...claim.shared.values()]
    .flat()
    .map(({ sessionId }) => sessionId)
    .sort();

describeWithEnv(
  "db > shared payment-reference claims",
  { db: true, encryptionKey: true },
  () => {
    test("two rows on one attendee expose one shared representation", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-same-attendee-a",
        "pi_same_attendee",
      );
      await finalizeProcessedPayment(
        "sess-same-attendee-b",
        attendeeId,
        "tok-b",
        taggedPaymentReference("pi_same_attendee"),
      );

      const held = await claimCurrentAttendeeRows([attendeeId], "keyless");

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(sharedSessions(held)).toEqual([
        "sess-same-attendee-a",
        "sess-same-attendee-b",
      ]);
    });

    test("a tagged reference claims its matching old untagged holder", async () => {
      const tagged = await bookedWithPayment("sess-alias-tagged", "pi_alias");
      await bookedWithPayment("sess-alias-untagged", "temporary_alias");
      const old = await storePaymentReference({
        kind: "untagged",
        reference: "pi_alias",
      });
      await repointPaymentRow("sess-alias-untagged", old);

      const held = await claimCurrentAttendeeRows([tagged], "keyless");

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(heldSessionIds(held).sort()).toEqual([
        "sess-alias-tagged",
        "sess-alias-untagged",
      ]);
      expect(sharedSessions(held)).toEqual([
        "sess-alias-tagged",
        "sess-alias-untagged",
      ]);
    });

    test("known providers sharing raw text remain separate identities", async () => {
      const stripe = await bookedWithPayment(
        "sess-provider-stripe",
        "same_provider_text",
      );
      const square = await bookedWithPayment(
        "sess-provider-square",
        "temporary_square_text",
      );
      const storedSquare = await storePaymentReference(
        taggedPaymentReference("same_provider_text", "square"),
      );
      await repointPaymentRow("sess-provider-square", storedSquare);

      const stripeHeld = await claimCurrentAttendeeRows([stripe], "keyless");
      const squareHeld = await claimCurrentAttendeeRows([square], "keyless");

      if (stripeHeld.kind !== "claimed" || squareHeld.kind !== "claimed") {
        throw new Error("the distinct provider claims were refused");
      }
      expect(heldSessionIds(stripeHeld)).toEqual(["sess-provider-stripe"]);
      expect(heldSessionIds(squareHeld)).toEqual(["sess-provider-square"]);
      expect(stripeHeld.shared).toEqual(new Map());
      expect(squareHeld.shared).toEqual(new Map());
    });

    test("an authenticated read anchors every rowless legacy holder", async () => {
      const listing = await createTestListing();
      const reference = "pi_global_legacy_holder";
      const first = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Global Legacy First",
        "global-legacy-first@example.com",
        reference,
      );
      const second = await createPaidAttendeeWithoutLedger(
        listing.id,
        "Global Legacy Second",
        "global-legacy-second@example.com",
        reference,
      );
      const index = await paymentReferenceIndex({
        kind: "untagged",
        reference,
      });

      const held = await claimCurrentAttendeeRows(
        [first.id],
        "keyless",
        new Map([[first.id, reference]]),
      );

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const expected = [
        anchorSessionId(first.id, index),
        anchorSessionId(second.id, index),
      ].sort();
      expect(heldSessionIds(held).sort()).toEqual(expected);
      expect(sharedSessions(held)).toEqual(expected);
    });
  },
);
