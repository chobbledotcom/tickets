/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { reserveSession } from "#db/processed-payments.ts";
import {
  type CallbackOutcome,
  settlePaymentCallback,
} from "#routes/api/payment-callback.ts";
import {
  buildSumupSession,
  resolveSumupCheckoutById,
} from "#shared/sumup/checkout-resolution.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { asSession } from "#test-utils/payment-session.ts";
import {
  stageSignedMultiItemSumupCheckout,
  stageSignedSumupCheckout,
  sumupCheckout,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

/** A real session, built the way the SumUp adapter builds one. `signed: false`
 * leaves out the price proof, which is the only thing that proves a paid
 * session is ours. */
const sessionFor = (status: "PAID" | "PENDING", signed: boolean) =>
  asSession(
    buildSumupSession(
      sumupCheckout({ reference: `cs_${status}_${signed}`, status }),
      {
        email: "alice@example.com",
        items: '[{"e":1,"q":1,"p":1000}]',
        name: "Alice",
        ...(signed ? { price_proof: "1000.not-a-real-signature" } : {}),
      },
    ),
  );

/** Settle a staged checkout the way the webhook does: resolve it from the
 * staged row (real signed metadata), then settle what came back. */
const settleStaged = async (
  checkoutId: string,
  reference: string,
): Promise<CallbackOutcome> => {
  const restore = withSumupCheckoutStatus(reference, "PAID", "txn_staged");
  try {
    const { resolved } = await resolveSumupCheckoutById(checkoutId, "Webhook");
    return await settlePaymentCallback(resolved, "Webhook");
  } finally {
    restore.restore();
  }
};

describeWithEnv("settlePaymentCallback", { db: true }, () => {
  test("asks to be tried again when the provider's answer was unusable", async () => {
    expect(await settlePaymentCallback("retry", "Webhook")).toEqual({
      kind: "refused",
    });
  });

  test("says nothing has happened when the provider says not yet", async () => {
    expect(await settlePaymentCallback("skip", "Webhook")).toEqual({
      kind: "not_yet",
    });
  });

  test("says it does not know the session when there is none", async () => {
    expect(await settlePaymentCallback(null, "Webhook")).toEqual({
      kind: "unrecognised",
    });
  });

  test("records an unpaid session rather than passing over it", async () => {
    // Kept apart from "not yet": the provider gave us a session and it is not
    // paid, which is worth a line in the log where a plain "not yet" is not.
    const outcome = await settlePaymentCallback(
      sessionFor("PENDING", true),
      "Webhook",
    );

    expect(outcome.kind).toBe("unpaid");
    expect("detail" in outcome && outcome.detail).toContain("status=unpaid");
  });

  test("names the caller in what it records, so an operator can tell them apart", async () => {
    // The webhook and the recovery check write the same facts. Which one was
    // running is the part that says whether a customer was waiting on it.
    const outcome = await settlePaymentCallback(
      sessionFor("PENDING", true),
      "Recovery check",
    );

    expect("detail" in outcome && outcome.detail).toContain("Recovery check");
  });

  test("will not touch money for a paid session nothing proves is ours", async () => {
    // No valid price proof: refunding could refund another site's payment.
    const outcome = await settlePaymentCallback(
      sessionFor("PAID", false),
      "Webhook",
    );

    expect(outcome.kind).toBe("unverifiable");
  });

  test("says another request holds the reservation right now", async () => {
    // Reserved but not finalized — the two-phase lock's mid-flight window.
    // Nobody has decided anything, so the answer asks the provider again
    // rather than reporting money moved.
    const { reference } = await stageSignedSumupCheckout("co_held");
    await reserveSession(reference);

    const outcome = await settleStaged("co_held", reference);

    expect(outcome.kind).toBe("held");
    expect("detail" in outcome && outcome.detail).toContain(
      "Payment is being processed",
    );
  });

  test("blames the booking's first listing when it cannot be read", async () => {
    // A multi-item booking's failure is attributed for the log, and the
    // booking belongs to its first listing — not whichever item a reader
    // last happened to look at.
    const { listings, reference } = await stageSignedMultiItemSumupCheckout(
      "co_first_item",
      2,
    );
    await reserveSession(reference);

    const outcome = await settleStaged("co_first_item", reference);

    expect(outcome.kind).toBe("held");
    expect("listingId" in outcome && outcome.listingId).toBe(listings[0]!.id);
  });
});
