/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  referenceIndexOf,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import {
  bindingRequest,
  claimCapability,
  legacyBooking,
  loadedReference,
  rowFor,
  taggedBooking,
} from "./payment-reference-provider/helpers.ts";

/* jscpd:ignore-end */

describeWithEnv(
  "db > binding payment references to providers",
  { db: true, encryptionKey: true },
  () => {
    test("rewrites every attendee row sharing one old reference", async () => {
      const raw = "legacy_shared_reference";
      const first = await legacyBooking("bind_shared_a", raw);
      await legacyBooking("bind_shared_b", raw);
      const held = await claimCurrentAttendeeRows([first], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const oldIndex = await paymentReferenceIndex({
        kind: "untagged",
        reference: raw,
      });
      const tagged = {
        kind: "tagged",
        provider: "stripe",
        reference: raw,
      } as const;
      const newIndex = await paymentReferenceIndex(tagged);

      const result = await bindPaymentReferenceProviders(
        bindingRequest(held, new Map([[oldIndex, tagged]])),
      );

      expect(result).toEqual({
        indexes: new Map([[oldIndex, newIndex]]),
        kind: "bound",
      });
      expect(await loadedReference("bind_shared_a")).toEqual(tagged);
      expect(await loadedReference("bind_shared_b")).toEqual(tagged);
      expect(await referenceIndexOf("bind_shared_a")).toBe(newIndex);
      expect(await referenceIndexOf("bind_shared_b")).toBe(newIndex);
      expect(await claimCapability("bind_shared_a")).toBe("keyed");
      expect(await claimCapability("bind_shared_b")).toBe("keyed");
    });

    test("uses one conservative capability for every held row", async () => {
      const attendeeId = await legacyBooking("bind_mixed_a", "legacy_stripe");
      await finalizeProcessedPayment("bind_mixed_b", attendeeId, "tok", {
        kind: "untagged",
        reference: "legacy_sumup",
      });
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const stripeOld = await paymentReferenceIndex({
        kind: "untagged",
        reference: "legacy_stripe",
      });
      const sumupOld = await paymentReferenceIndex({
        kind: "untagged",
        reference: "legacy_sumup",
      });

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(
            held,
            new Map<string, TaggedPaymentReference>([
              [
                stripeOld,
                {
                  kind: "tagged",
                  provider: "stripe",
                  reference: "legacy_stripe",
                },
              ],
              [
                sumupOld,
                {
                  kind: "tagged",
                  provider: "sumup",
                  reference: "legacy_sumup",
                },
              ],
            ]),
            "keyless",
          ),
        ),
      ).toMatchObject({ kind: "bound" });
      expect(await claimCapability("bind_mixed_a")).toBe("keyless");
      expect(await claimCapability("bind_mixed_b")).toBe("keyless");
    });

    test("a changed exact claim leaves every reference untouched", async () => {
      const attendeeId = await legacyBooking("bind_changed", "legacy_changed");
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const before = await rowFor("bind_changed");
      const oldIndex = before.payment_reference_index;

      const result = await bindPaymentReferenceProviders({
        ...bindingRequest(
          held,
          new Map([
            [
              oldIndex,
              {
                kind: "tagged",
                provider: "stripe",
                reference: "legacy_changed",
              },
            ],
          ]),
        ),
        heldSince: `${held.heldSince}-superseded`,
      });

      expect(result).toEqual({ kind: "claim_changed" });
      expect(await rowFor("bind_changed")).toEqual(before);
    });

    test("an uncovered held reference is a changed payment set", async () => {
      const attendeeId = await legacyBooking(
        "bind_uncovered",
        "legacy_uncovered",
      );
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const before = await rowFor("bind_uncovered");

      expect(
        await bindPaymentReferenceProviders(bindingRequest(held, new Map())),
      ).toEqual({ kind: "claim_changed" });
      expect(await rowFor("bind_uncovered")).toEqual(before);
    });

    test("a binding for a different raw reference fails before writing", async () => {
      const attendeeId = await legacyBooking("bind_wrong_raw", "legacy_right");
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      const before = await rowFor("bind_wrong_raw");

      await expect(
        bindPaymentReferenceProviders(
          bindingRequest(
            held,
            new Map([
              [
                before.payment_reference_index,
                {
                  kind: "tagged",
                  provider: "stripe",
                  reference: "legacy_wrong",
                },
              ],
            ]),
          ),
        ),
      ).rejects.toThrow("does not match legacy_wrong");
      expect(await rowFor("bind_wrong_raw")).toEqual(before);
    });

    test("a historical marker on any sharing old row refuses all writes", async () => {
      const raw = "legacy_historical_marker";
      const attendeeId = await legacyBooking("bind_marker_a", raw);
      await legacyBooking("bind_marker_b", raw);
      const held = await claimCurrentAttendeeRows([attendeeId], "unresolved");
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await execute(
        `UPDATE processed_payments
            SET provider_refunded_at = ?
          WHERE payment_session_id = ?`,
        ["2026-08-11T10:00:00.000Z", "bind_marker_b"],
      );
      const before = await Promise.all([
        rowFor("bind_marker_a"),
        rowFor("bind_marker_b"),
      ]);
      const oldIndex = before[0].payment_reference_index;

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(
            held,
            new Map<string, TaggedPaymentReference>([
              [
                oldIndex,
                {
                  kind: "tagged",
                  provider: "square",
                  reference: raw,
                },
              ],
            ]),
          ),
        ),
      ).toEqual({ indexes: [oldIndex], kind: "historical_marker" });
      expect(
        await Promise.all([rowFor("bind_marker_a"), rowFor("bind_marker_b")]),
      ).toEqual(before);
      expect(await claimCapability("bind_marker_a")).toBe("unresolved");
    });

    test("identity bindings allow old markers and keep providers distinct", async () => {
      const stripe = {
        kind: "tagged",
        provider: "stripe",
        reference: "same_provider_id",
      } as const;
      const square = { ...stripe, provider: "square" } as const;
      const stripeAttendee = await taggedBooking("bind_tagged_stripe", stripe);
      const squareAttendee = await taggedBooking("bind_tagged_square", square);
      const held = await claimCurrentAttendeeRows(
        [stripeAttendee, squareAttendee],
        "unresolved",
      );
      if (held.kind !== "claimed") throw new Error("the claim was refused");
      await execute(
        `UPDATE processed_payments
            SET provider_refunded_at = ?
          WHERE payment_session_id = ?`,
        ["2026-08-11T10:00:00.000Z", "bind_tagged_stripe"],
      );
      const stripeIndex = await paymentReferenceIndex(stripe);
      const squareIndex = await paymentReferenceIndex(square);

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(
            held,
            new Map<string, TaggedPaymentReference>([
              [stripeIndex, stripe],
              [squareIndex, square],
            ]),
          ),
        ),
      ).toEqual({
        indexes: new Map([
          [stripeIndex, stripeIndex],
          [squareIndex, squareIndex],
        ]),
        kind: "bound",
      });
      expect(stripeIndex).not.toBe(squareIndex);
      expect(await claimCapability("bind_tagged_stripe")).toBe("keyed");
      expect(await claimCapability("bind_tagged_square")).toBe("keyed");
    });

    test("an empty held set binds nothing", async () => {
      expect(
        await bindPaymentReferenceProviders({
          bindings: new Map(),
          capability: "keyed",
          held: new Map(),
          heldSince: "2026-08-11T12:00:00.000Z",
        }),
      ).toEqual({ indexes: new Map(), kind: "bound" });

      const tagged = {
        kind: "tagged",
        provider: "stripe",
        reference: "unheld_reference",
      } as const;
      expect(
        await bindPaymentReferenceProviders({
          bindings: new Map([[await paymentReferenceIndex(tagged), tagged]]),
          capability: "keyed",
          held: new Map(),
          heldSince: "2026-08-11T12:00:00.000Z",
        }),
      ).toEqual({ kind: "claim_changed" });
    });

    test("refuses a held session named for two attendees", async () => {
      await expect(
        bindPaymentReferenceProviders({
          bindings: new Map(),
          capability: "keyed",
          held: new Map([
            [1, ["duplicate_session"]],
            [2, ["duplicate_session"]],
          ]),
          heldSince: "2026-08-11T12:00:00.000Z",
        }),
      ).rejects.toThrow("repeated a held session");
    });
  },
);
