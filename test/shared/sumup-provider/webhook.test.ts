import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import {
  makeSumupClient,
  SUMUP_META,
  stageSumupCheckout,
  sumupCheckout,
  withFetchedSumupCheckout,
  withSumupClient,
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

  /** The refusal a paid charge earns when its money was captured but the
   *  boundary cannot read its amount or currency. */
  const REFUNDABLE_REJECTION = {
    metadata: SUMUP_META,
    paymentReference: "txn",
    reason: "malformed_charge",
    refundable: true,
  };

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

  test("returns null when the checkout cannot be fetched", async () => {
    await stageSumupCheckout();
    await withFetchedSumupCheckout(null, async () => {
      expect(await resolveStaged()).toBeNull();
    });
  });

  for (const [name, checkoutOverrides] of [
    ["a malformed paid charge", { currency: "GB" }],
    ["an over-precise paid charge", { overPrecise: true }],
    ["a paid charge with no currency", { currency: null }],
  ] as const) {
    test(`returns a refundable rejection for ${name}`, async () => {
      await stageSumupCheckout();
      await withFetchedSumupCheckout(
        sumupCheckout(checkoutOverrides),
        async () => {
          expect(await resolveStaged()).toEqual(REFUNDABLE_REJECTION);
        },
      );
    });
  }

  test("hands a paid charge SumUp priced in a malformed currency to the refund path", async () => {
    await stageSumupCheckout();
    // The real adapter reads this response: a currency the currency helpers
    // cannot format must not make the fetch fail, or the webhook would ack
    // the charge as unrecognized and the captured money would be stranded.
    await withSumupClient(
      makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref",
            currency: "GB",
            status: "PAID",
            transaction_id: "txn",
          }),
      }),
      async () => {
        expect(await resolveStaged()).toEqual(REFUNDABLE_REJECTION);
      },
    );
  });

  // The webhook id proved a staged row exists, so the reference SumUp answers
  // with must name that same row. Anything else — blank, unheard-of, or
  // another booking's — is refused rather than processed under the wrong
  // metadata. "ref_other" is staged under its own SumUp id below.
  for (const [name, reference] of [
    ["is blank", ""],
    ["matches no staged row", "unrelated"],
    ["maps to a different staged row", "ref_other"],
  ] as const) {
    test(`returns null when the checkout reference ${name}`, async () => {
      await stageSumupCheckout();
      await storeSumupCheckout("ref_other", SUMUP_META);
      await setSumupCheckoutId("ref_other", "co_other");
      await withFetchedSumupCheckout(sumupCheckout({ reference }), async () => {
        expect(await resolveStaged()).toBeNull();
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
