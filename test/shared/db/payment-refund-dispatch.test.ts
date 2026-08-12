import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { bindPaymentReferenceProviders } from "#shared/db/payment-reference-provider.ts";
import { paymentReferenceIndex } from "#shared/db/payment-reference-store.ts";
import { armRefundDispatch } from "#shared/db/payment-refund-dispatch.ts";
import type { TaggedPaymentReference } from "#shared/payment/provider-reference.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  claimCurrentAttendeeRows,
  heldSessionIds,
  makeClaimsStale,
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
  return { claim, indexes: [...result.indexes.values()] };
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
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);

      const result = await arm(claim, indexes);

      expect(result).toMatchObject({ kind: "armed" });
      if (result.kind !== "armed") throw new Error("dispatch was not armed");
      expect(result.permits.get(indexes[0]!)).toMatchObject({
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
      const { claim, indexes } = await boundClaim(attendeeId, [identity]);
      await arm(claim, indexes);

      const retry = await arm(claim, indexes);

      expect(retry).toMatchObject({ kind: "armed" });
      if (retry.kind !== "armed") throw new Error("retry was not armed");
      expect(retry.permits.get(indexes[0]!)).toMatchObject({
        capability: "keyed",
        commandId: claim.commandId,
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
  },
);
