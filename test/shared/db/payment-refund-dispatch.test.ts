import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { armRefundDispatch } from "#shared/db/payment-refund-dispatch.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { requireValue } from "#shared/required-value.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  CLAIM_MIRROR,
  claimCurrentAttendeeRows,
  heldSessionIds,
  makeClaimsStale,
  putRowState,
  rowStateSlot,
} from "#test-utils/payment-claim.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import {
  bindingRequest,
  storedClaim,
  taggedBooking,
} from "./payment-reference-provider/helpers.ts";

const tagged = (
  reference: string,
  provider: TaggedPaymentReference["provider"] = "stripe",
): TaggedPaymentReference => ({ kind: "tagged", provider, reference });

const boundClaim = async (
  attendeeId: number,
  identities: readonly TaggedPaymentReference[],
) => {
  const claim = await claimCurrentAttendeeRows([attendeeId]);
  if (claim.kind !== "claimed") throw new Error("the claim was refused");
  const bindings = new Map(
    await Promise.all(
      identities.map(
        async (identity) =>
          [await paymentReferenceIndex(identity), identity] as const,
      ),
    ),
  );
  const result = await bindPaymentReferenceProviders(
    bindingRequest(claim, bindings, ({ provider }) =>
      provider === "sumup" ? "keyless" : "keyed",
    ),
  );
  if (result.kind !== "bound") throw new Error("the binding was refused");
  const indexes = [...result.indexes.values()];
  return {
    claim,
    firstIndex: requireValue(indexes[0], "the binding returned no index"),
    indexes,
  };
};

const arm = (
  claim: Awaited<ReturnType<typeof boundClaim>>["claim"],
  indexes: readonly string[],
) => armRefundDispatch({ ...claim, indexes });

describeWithEnv(
  "db > arming provider refund dispatch",
  { db: true, encryptionKey: true },
  () => {
    test("a ready keyless payment receives one durable dispatch permit", async () => {
      const identity = tagged("dispatch_keyless", "sumup");
      const attendeeId = await taggedBooking("dispatch-keyless", identity);
      const { claim, firstIndex, indexes } = await boundClaim(attendeeId, [
        identity,
      ]);

      const result = await arm(claim, indexes);

      expect(result).toMatchObject({ kind: "armed" });
      if (result.kind !== "armed") throw new Error("dispatch was not armed");
      expect(result.permits.get(firstIndex)).toMatchObject({
        capability: "keyless",
        commandId: claim.commandId,
        kind: "refund_dispatch",
      });
      expect(await storedClaim("dispatch-keyless")).toMatchObject({
        capability: "keyless",
        phase: "send_armed",
      });
    });

    test("an armed keyed payment can repeat the same command", async () => {
      const identity = tagged("dispatch_keyed");
      const attendeeId = await taggedBooking("dispatch-keyed", identity);
      const { claim, firstIndex, indexes } = await boundClaim(attendeeId, [
        identity,
      ]);
      await arm(claim, indexes);

      const retry = await arm(claim, indexes);

      expect(retry).toMatchObject({ kind: "armed" });
      if (retry.kind !== "armed") throw new Error("retry was not armed");
      expect(retry.permits.get(firstIndex)).toMatchObject({
        capability: "keyed",
        commandId: claim.commandId,
      });
    });

    test("an armed command cannot change provider capability", async () => {
      const identity = tagged("dispatch-capability-change");
      const attendeeId = await taggedBooking(
        "dispatch-capability-change",
        identity,
      );
      const { claim, firstIndex, indexes } = await boundClaim(attendeeId, [
        identity,
      ]);
      await arm(claim, indexes);

      await expect(
        bindPaymentReferenceProviders(
          bindingRequest(
            claim,
            new Map([[firstIndex, identity]]),
            () => "keyless",
          ),
        ),
      ).rejects.toThrow(
        `Provider capability changed for armed payment ${firstIndex}`,
      );
      expect(await storedClaim("dispatch-capability-change")).toMatchObject({
        capability: "keyed",
        phase: "send_armed",
      });
    });

    test("re-binding an armed reference preserves its dispatch boundary", async () => {
      const identity = tagged("dispatch-already-armed");
      const attendeeId = await taggedBooking(
        "dispatch-already-armed",
        identity,
      );
      const {
        claim,
        firstIndex: index,
        indexes,
      } = await boundClaim(attendeeId, [identity]);
      await arm(claim, indexes);

      expect(
        await bindPaymentReferenceProviders(
          bindingRequest(claim, new Map([[index, identity]])),
        ),
      ).toEqual({
        indexes: new Map([[index, index]]),
        kind: "bound",
      });
      expect(await storedClaim("dispatch-already-armed")).toMatchObject({
        capability: "keyed",
        phase: "send_armed",
      });
    });

    test("an armed keyless payment requires an owner review", async () => {
      const identity = tagged("dispatch_uncertain", "sumup");
      const attendeeId = await taggedBooking("dispatch-uncertain", identity);
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);
      await arm(claim, indexes);

      expect(await arm(claim, indexes)).toEqual({
        indexes,
        kind: "owner_review",
        reason: "uncertain_keyless_refund",
      });
    });

    test("one uncertain sibling prevents every fresh sibling being armed", async () => {
      const sumup = tagged("dispatch_mixed_sumup", "sumup");
      const stripe = tagged("dispatch_mixed_stripe");
      const attendeeId = await taggedBooking("dispatch-mixed-sumup", sumup);
      await finalizeProcessedPayment(
        "dispatch-mixed-stripe",
        attendeeId,
        "tok",
        stripe,
      );
      const { claim, indexes } = await boundClaim(attendeeId, [sumup, stripe]);
      const sumupIndex = await paymentReferenceIndex(sumup);
      await arm(claim, [sumupIndex]);

      expect(await arm(claim, indexes)).toEqual({
        indexes: [sumupIndex],
        kind: "owner_review",
        reason: "uncertain_keyless_refund",
      });
      expect(await storedClaim("dispatch-mixed-stripe")).toMatchObject({
        phase: "ready",
      });
    });

    test("every representation of one reference crosses the boundary together", async () => {
      const identity = tagged("dispatch_shared");
      const first = await taggedBooking("dispatch-shared-a", identity);
      await taggedBooking("dispatch-shared-b", identity);
      const { claim, indexes } = await boundClaim(first, [identity]);

      expect(await arm(claim, indexes)).toMatchObject({ kind: "armed" });
      expect(await storedClaim("dispatch-shared-a")).toMatchObject({
        phase: "send_armed",
      });
      expect(await storedClaim("dispatch-shared-b")).toMatchObject({
        phase: "send_armed",
      });
    });

    test("a stale pre-arm keyless command starts safely from checking", async () => {
      const identity = tagged("dispatch_prearm", "sumup");
      const attendeeId = await taggedBooking("dispatch-prearm", identity);
      const { claim } = await boundClaim(attendeeId, [identity]);
      await makeClaimsStale(heldSessionIds(claim));

      const resumed = await claimCurrentAttendeeRows([attendeeId]);

      expect(resumed).toMatchObject({ inherited: new Map(), kind: "claimed" });
      expect(await storedClaim("dispatch-prearm")).toMatchObject({
        phase: "checking",
      });
    });

    test("rejects malformed reference sets before opening a transaction", async () => {
      const request = {
        commandId: "malformed-dispatch",
        held: new Map<number, readonly string[]>(),
        heldSince: "2026-08-12T12:00:00.000Z",
      };
      for (const indexes of [[""], ["same", "same"]]) {
        await expect(
          armRefundDispatch({ ...request, indexes }),
        ).rejects.toThrow(
          "Refund dispatch indexes must be distinct and non-empty",
        );
      }
    });

    test("arming no references is an empty successful command", async () => {
      expect(
        await armRefundDispatch({
          commandId: "empty-dispatch",
          held: new Map(),
          heldSince: "2026-08-12T12:00:00.000Z",
          indexes: [],
        }),
      ).toEqual({ kind: "armed", permits: new Map(), phases: new Map() });
    });

    test("a changed claim command refuses the whole dispatch", async () => {
      const identity = tagged("dispatch-changed-command");
      const attendeeId = await taggedBooking(
        "dispatch-changed-command",
        identity,
      );
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);

      expect(
        await armRefundDispatch({
          ...claim,
          commandId: "replacement-command",
          indexes,
        }),
      ).toEqual({ kind: "claim_changed" });
      expect(await storedClaim("dispatch-changed-command")).toMatchObject({
        phase: "ready",
      });
    });

    test("a payment row moved to another attendee refuses dispatch", async () => {
      const identity = tagged("dispatch-moved-attendee");
      const attendeeId = await taggedBooking(
        "dispatch-moved-attendee",
        identity,
      );
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);
      const sessions = [...claim.held.values()].flat();

      expect(
        await armRefundDispatch({
          ...claim,
          held: new Map([[attendeeId + 1, sessions]]),
          indexes,
        }),
      ).toEqual({ kind: "claim_changed" });
      expect(await storedClaim("dispatch-moved-attendee")).toMatchObject({
        phase: "ready",
      });
    });

    test("a checking claim has not crossed the provider boundary", async () => {
      const identity = tagged("dispatch-still-checking");
      const attendeeId = await taggedBooking(
        "dispatch-still-checking",
        identity,
      );
      const claim = await claimCurrentAttendeeRows([attendeeId]);
      if (claim.kind !== "claimed") throw new Error("the claim was refused");
      const index = await paymentReferenceIndex(identity);

      expect(await arm(claim, [index])).toEqual({ kind: "claim_changed" });
      expect(await storedClaim("dispatch-still-checking")).toMatchObject({
        phase: "checking",
      });
    });

    test("conflicting capabilities on one reference fail loudly", async () => {
      const identity = tagged("dispatch-conflicting-capabilities");
      const attendeeId = await taggedBooking(
        "dispatch-conflicting-a",
        identity,
      );
      await finalizeProcessedPayment(
        "dispatch-conflicting-b",
        attendeeId,
        "tok-conflicting-b",
        identity,
      );
      const { claim, firstIndex, indexes } = await boundClaim(attendeeId, [
        identity,
      ]);
      const secondClaim = await storedClaim("dispatch-conflicting-b");
      if (secondClaim.phase !== "ready") {
        throw new Error("the second payment row was not ready");
      }
      await putRowState(
        "dispatch-conflicting-b",
        await rowStateSlot({
          claim: { ...secondClaim, capability: "keyless" },
        }),
        CLAIM_MIRROR,
      );

      await expect(arm(claim, indexes)).rejects.toThrow(
        `Payment ${firstIndex} has conflicting refund capabilities`,
      );
      expect(await storedClaim("dispatch-conflicting-a")).toMatchObject({
        capability: "keyed",
        phase: "ready",
      });
    });

    test("a missed arm write rolls the whole dispatch back", async () => {
      const identity = tagged("dispatch-missed-write");
      const attendeeId = await taggedBooking("dispatch-missed-write", identity);
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);
      await execute(
        `CREATE TRIGGER ignore_refund_dispatch
          BEFORE UPDATE ON processed_payments
          WHEN OLD.payment_session_id = 'dispatch-missed-write'
          BEGIN SELECT RAISE(IGNORE); END`,
      );

      await expect(arm(claim, indexes)).rejects.toThrow(
        "Refund dispatch could not arm every payment row",
      );
      expect(await storedClaim("dispatch-missed-write")).toMatchObject({
        phase: "ready",
      });
    });
  },
);
