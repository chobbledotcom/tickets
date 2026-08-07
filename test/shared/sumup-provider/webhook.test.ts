import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  SUMUP_META,
  stageSumupCheckout,
  sumupCheckout,
  withFetchedSumupCheckout,
} from "#test-utils/sumup.ts";

describe("sumup-provider resolveWebhookSession", () => {
  beforeEach(async () => {
    await createTestDb();
  });

  afterEach(() => {
    resetDb();
  });

  const listing = (id: string) => ({
    data: { object: { id } },
    id,
    type: "CHECKOUT_STATUS_CHANGED",
  });

  /** Resolve the webhook the staging row maps to SumUp id "co_1". */
  const resolveStaged = () =>
    sumupPaymentProvider.resolveWebhookSession(listing("co_1"));

  test("returns null when the listing carries no id", async () => {
    expect(
      await sumupPaymentProvider.resolveWebhookSession(listing("")),
    ).toBeNull();
  });

  test("skips ids we never created without calling SumUp", async () => {
    await stageSumupCheckout();
    await withFetchedSumupCheckout(sumupCheckout(), async (calls) => {
      expect(
        await sumupPaymentProvider.resolveWebhookSession(listing("co_spam")),
      ).toBe("skip");
      expect(calls()).toEqual([]);
    });
  });

  test("asks to be retried when a staged checkout cannot be fetched", async () => {
    // The staging row already proved this checkout is ours, so a failed fetch
    // is SumUp being unreachable, not a checkout we have never heard of.
    // Acknowledging it would be terminal — SumUp never redelivers — and a paid
    // checkout would sit with the money taken and no booking.
    await stageSumupCheckout();
    await withFetchedSumupCheckout(null, async () => {
      await expect(resolveStaged()).rejects.toThrow("co_1");
    });
  });

  // The webhook id proved a staged row exists, so the reference SumUp answers
  // with must name that same row. Anything else — blank, unheard-of, or
  // another booking's — is SumUp contradicting itself about a checkout we
  // made. The booking is encrypted under that reference, so without a match we
  // can neither read it nor prove the charge is ours to refund, and
  // acknowledging would strand a paid one for good. "ref_other" is staged
  // under its own SumUp id below.
  for (const [name, reference] of [
    ["is blank", ""],
    ["matches no staged row", "unrelated"],
    ["maps to a different staged row", "ref_other"],
  ] as const) {
    test(`asks to be retried when the checkout reference ${name}`, async () => {
      await stageSumupCheckout();
      await storeSumupCheckout("ref_other", SUMUP_META);
      await setSumupCheckoutId("ref_other", "co_other");
      await withFetchedSumupCheckout(sumupCheckout({ reference }), async () => {
        await expect(resolveStaged()).rejects.toThrow(
          "is not the one staged for it",
        );
      });
    });
  }

  test("skips when the payment is not yet paid", async () => {
    await stageSumupCheckout();
    await withFetchedSumupCheckout(
      sumupCheckout({ status: "PENDING", transactionId: "" }),
      async () => {
        expect(await resolveStaged()).toBe("skip");
      },
    );
  });

  test("fetches the checkout by listing id and returns the paid session", async () => {
    await stageSumupCheckout();
    await withFetchedSumupCheckout(sumupCheckout(), async (calls) => {
      const result = await resolveStaged();
      expect(result).toEqual(
        expect.objectContaining({ id: "ref", paymentReference: "txn" }),
      );
      expect(calls()).toEqual([["co_1"]]);
    });
  });
});
