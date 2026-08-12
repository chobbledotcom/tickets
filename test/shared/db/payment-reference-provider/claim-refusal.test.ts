/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import {
  bindingRequest,
  legacyBooking,
  rowFor,
} from "#test/shared/db/payment-reference-provider/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { claimCurrentAttendeeRows } from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";

/* jscpd:ignore-end */

const bindingsFor = async (
  references: readonly string[],
): Promise<ReadonlyMap<string, TaggedPaymentReference>> =>
  new Map(
    await Promise.all(
      references.map(
        async (reference) =>
          [
            await paymentReferenceIndex({ kind: "untagged", reference }),
            { kind: "tagged", provider: "stripe", reference } as const,
          ] as const,
      ),
    ),
  );

describeWithEnv(
  "db > payment provider binding exact claim refusals",
  { db: true, encryptionKey: true },
  () => {
    test("a held row removed before binding leaves its sibling untouched", async () => {
      const attendeeId = await legacyBooking(
        "bind_missing_a",
        "legacy_missing_a",
      );
      await finalizeProcessedPayment("bind_missing_b", attendeeId, "tok", {
        kind: "untagged",
        reference: "legacy_missing_b",
      });
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const before = await rowFor("bind_missing_b");
      await execute(
        "DELETE FROM processed_payments WHERE payment_session_id = ?",
        ["bind_missing_a"],
      );

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(
            held,
            await bindingsFor(["legacy_missing_a", "legacy_missing_b"]),
          ),
        ),
      ).toEqual({ kind: "claim_changed" });
      expect(await rowFor("bind_missing_b")).toEqual(before);
    });

    test("a held session attributed to another attendee is untouched", async () => {
      const attendeeId = await legacyBooking(
        "bind_wrong_attendee",
        "legacy_wrong_attendee",
      );
      const otherAttendeeId = await legacyBooking(
        "bind_wrong_attendee_other",
        "legacy_wrong_attendee_other",
      );
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const sessionIds = held.held.get(attendeeId);
      if (sessionIds === undefined) throw new Error("the held row was missing");
      const before = await rowFor("bind_wrong_attendee");

      expect(
        await bindPaymentReferenceProviders({
          ...bindingRequest(held, await bindingsFor(["legacy_wrong_attendee"])),
          held: new Map([[otherAttendeeId, sessionIds]]),
        }),
      ).toEqual({ kind: "claim_changed" });
      expect(await rowFor("bind_wrong_attendee")).toEqual(before);
    });

    test("an extra binding outside the held set leaves the claim untouched", async () => {
      const attendeeId = await legacyBooking(
        "bind_extra_reference",
        "legacy_held_reference",
      );
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const before = await rowFor("bind_extra_reference");

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(
            held,
            await bindingsFor([
              "legacy_held_reference",
              "legacy_never_held_reference",
            ]),
          ),
        ),
      ).toEqual({ kind: "claim_changed" });
      expect(await rowFor("bind_extra_reference")).toEqual(before);
    });
  },
);
