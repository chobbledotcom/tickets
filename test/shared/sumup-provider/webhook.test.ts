import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { setSumupCheckoutId, storeSumupCheckout } from "#db/sumup-checkouts.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import { createTestDb, resetDb } from "#test-utils/db.ts";
import { BLANK_SESSION_METADATA } from "#test-utils/payment-session.ts";
import {
  makeSumupClient,
  SUMUP_META,
  stageSumupCheckout,
  sumupCheckout,
  withFetchedSumupCheckout,
  withSumupCheckoutRead,
  withSumupClient,
} from "#test-utils/sumup.ts";

describe("sumup-provider resolveWebhookSession", () => {
  beforeEach(async () => {
    await createTestDb();
    settings.setForTest({
      sumup_api_key: "sk_test_abc",
      sumup_merchant_code: "MC123",
    });
  });

  afterEach(() => {
    settings.clearTestOverrides();
    resetDb();
  });

  const listing = (id: string) => ({
    data: { object: { id } },
    id,
    type: "CHECKOUT_STATUS_CHANGED",
  });

  const resolve = (id: string) =>
    sumupPaymentProvider.resolveWebhookSession(listing(id));

  /** Resolve the webhook the staging row maps to SumUp id "co_1". */
  const resolveStaged = () => resolve("co_1");

  /** The refusal a paid charge earns when its money was captured but the
   *  boundary cannot read its amount or currency. The metadata comes back in
   *  the canonical shape the price proof was signed over, not as staged. */
  const REFUNDABLE_REJECTION = {
    metadata: { ...BLANK_SESSION_METADATA, ...SUMUP_META },
    paymentReference: "txn",
    provider: "sumup",
    reason: "malformed_charge",
    refundable: true,
    sessionId: "ref",
  };

  // Blank, or longer than any id SumUp mints: the same fixed refusal as
  // every other unstaged callback, before even a database lookup — so the
  // payload is never echoed into a log and the answer's shape leaks nothing.
  for (const [name, id] of [
    ["a blank id", ""],
    ["an id too long to be real", "x".repeat(256)],
  ] as const) {
    test(`refuses ${name} without any lookup`, async () => {
      await withSumupCheckoutRead({ status: "missing" }, async (calls) => {
        expect(await resolve(id)).toBe("retry");
        expect(calls()).toEqual([]);
      });
    });
  }

  test("treats a 255-byte id like any other staged checkout", async () => {
    const longId = "x".repeat(255);
    await storeSumupCheckout("ref255", SUMUP_META);
    await setSumupCheckoutId("ref255", longId);
    await withFetchedSumupCheckout(
      sumupCheckout({ reference: "ref255" }),
      async () => {
        expect(await resolve(longId)).toEqual(
          expect.objectContaining({ id: "ref255" }),
        );
      },
    );
  });

  test("asks ids we never created to be retried without calling SumUp", async () => {
    // Refusing retryably (not acknowledging) covers a real callback racing
    // our own staging write, and costs a forger nothing but one indexed read.
    await stageSumupCheckout();
    await withFetchedSumupCheckout(sumupCheckout(), async (calls) => {
      expect(await resolve("co_spam")).toBe("retry");
      expect(calls()).toEqual([]);
    });
  });

  // The staging row already proved the checkout is ours, so anything but a
  // clean read answers retryably: acknowledging is terminal, and a paid
  // checkout would sit with the money taken and no booking.
  for (const [name, read] of [
    ["SumUp says it does not exist", { status: "missing" }],
    [
      "SumUp cannot be reached",
      { reason: "network_error", status: "unavailable" },
    ],
    [
      "the answer contradicts our facts",
      { reason: "mismatched_account", status: "invalid" },
    ],
  ] as const) {
    test(`asks to be retried when ${name}`, async () => {
      await stageSumupCheckout();
      await withSumupCheckoutRead(read, async () => {
        expect(await resolveStaged()).toBe("retry");
      });
    });
  }

  for (const [name, checkoutOverrides] of [
    ["a malformed paid charge", { currency: "GB" }],
    ["a paid charge with no readable amount", { amountMinor: null }],
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
    // The real adapter reads this response through the real classifier: the
    // ownership facts (id, merchant, named transaction) all agree, so the
    // unreadable money must reach the refund path rather than refuse the
    // read — otherwise the captured charge would be stranded.
    await withSumupClient(
      makeSumupClient({
        get: () =>
          Promise.resolve({
            amount: 10,
            checkout_reference: "ref",
            currency: "GB",
            id: "co_1",
            merchant_code: "MC123",
            status: "PAID",
            transaction_id: "txn",
            transactions: [
              {
                amount: 10,
                currency: "GB",
                id: "txn",
                merchant_code: "MC123",
                status: "SUCCESSFUL",
              },
            ],
          }),
      }),
      async () => {
        expect(await resolveStaged()).toEqual(REFUNDABLE_REJECTION);
      },
    );
  });

  // The webhook id proved a staged row exists, so the reference SumUp answers
  // with must name that same row. Anything else — blank, unheard-of, or
  // another booking's — is SumUp contradicting itself about a checkout we
  // made. The booking is encrypted under that reference, so without a match
  // we can neither read it nor prove the charge is ours to refund; refusing
  // retryably keeps SumUp redelivering instead of stranding a paid charge.
  // "ref_other" is staged under its own SumUp id below.
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
        expect(await resolveStaged()).toBe("retry");
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
