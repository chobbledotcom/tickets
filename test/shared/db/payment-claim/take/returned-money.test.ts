import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { paymentReferenceIndex } from "#db/payment-reference-store.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  putRowState,
  rowStateSlot,
  UNRECORDED_MIRROR,
} from "#test-utils/payment-claim.ts";
import {
  getCompleteRefundPaymentReferencesForAttendee,
  markProviderRefundsReturned,
} from "#test-utils/payment-references.ts";
import {
  bookedWithPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";

describeWithEnv(
  "db > taking a payment claim > returned money",
  { db: true, encryptionKey: true },
  () => {
    test("names rows whose returned money is not in the books", async () => {
      const attendeeId = await bookedWithPayment(
        "sess-unrecorded",
        "pi_unrecorded",
      );
      await putRowState(
        "sess-unrecorded",
        await rowStateSlot({
          unrecorded: { returnedAt: "2026-08-11T10:00:00.000Z" },
        }),
        UNRECORDED_MIRROR,
      );

      const held = await claimCurrentAttendeeRows([attendeeId]);

      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect(held.unrecorded).toEqual(
        new Map([[attendeeId, ["sess-unrecorded"]]]),
      );
    });

    test("names a reference whose canonical charge says came back", async () => {
      const attendeeId = await bookedWithPayment("sess-q", "pi_already_back");
      await markProviderRefundsReturned(
        await getCompleteRefundPaymentReferencesForAttendee({
          currentPaymentId: "pi_already_back",
          id: attendeeId,
        }),
      );
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect([...held.returned]).toEqual([
        await paymentReferenceIndex(taggedPaymentReference("pi_already_back")),
      ]);
    });

    test("names a returned reference represented by a sharing row", async () => {
      const ours = await bookedWithPayment("sess-s1", "pi_shared_back");
      await bookedWithPayment("sess-s2", "pi_shared_back");
      await markProviderRefundsReturned(
        await getCompleteRefundPaymentReferencesForAttendee({
          currentPaymentId: "pi_shared_back",
          id: ours,
        }),
      );
      const held = await claimCurrentAttendeeRows([ours]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect([...held.returned]).toEqual([
        await paymentReferenceIndex(taggedPaymentReference("pi_shared_back")),
      ]);
    });

    test("names nothing while the money is still out", async () => {
      const attendeeId = await bookedWithPayment("sess-r", "pi_still_out");
      const held = await claimCurrentAttendeeRows([attendeeId]);
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      expect([...held.returned]).toEqual([]);
    });
  },
);
