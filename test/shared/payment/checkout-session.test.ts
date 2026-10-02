/** The checkout-session factory stages a checkout's free-text answers beside
 * the session id the provider hands back, in one write, and only when the
 * buyer typed any. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#crypto/hashing.ts";
import { takeCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { execute } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import { stageSquareLinkEnd } from "#db/square-link-ends.ts";
import { makeCreateCheckoutSession } from "#payment/checkout-session.ts";
import { WEBHOOK_RETRY_WINDOW_DAYS } from "#shared/limits.ts";
import { DAY_MS, isoBefore } from "#shared/now.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { squareApi } from "#shared/square/api.ts";
import { squareLinkEndsAt } from "#shared/square/checkout.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const intent = (textAnswers?: Record<string, string>): CheckoutIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items: [
    {
      listingId: 1,
      name: "Fete",
      quantity: 1,
      slug: "fete",
      unitPrice: 1000,
    },
  ],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...(textAnswers ? { textAnswers } : {}),
});

/** A provider that always accepts and names a fixed session. */
const acceptingProvider = makeCreateCheckoutSession(
  "stripe",
  () => Promise.resolve({ id: "cs_staging", url: "https://pay.example" }),
  (result) => ({ id: result.id, url: result.url }),
);

describeWithEnv(
  "makeCreateCheckoutSession answer staging",
  { db: true },
  () => {
    test("stages typed answers in one write, keyed by the session id", async () => {
      const calls = await countDatabaseCalls(1, () =>
        acceptingProvider(intent({ "7": "Coming by bus" }), "https://site"),
      );

      expect(calls).toBe(1);
      expect(await takeCheckoutAnswers("cs_staging")).toEqual(
        new Map([[7, "Coming by bus"]]),
      );
    });

    test("spends no database call when the buyer typed no free text", async () => {
      const calls = await countDatabaseCalls(0, () =>
        acceptingProvider(intent(), "https://site"),
      );

      expect(calls).toBe(0);
    });

    /** Stage a Square checkout whose link Square made `ageDays` ago, with its
     * handle and answers rows as old as the link, then run the prune. */
    const squareCheckoutAgedDays = async (
      sessionId: string,
      ageDays: number,
    ) => {
      const createdAt = isoBefore(ageDays * DAY_MS);
      using _link = stub(squareApi, "createPaymentLink", () =>
        Promise.resolve({
          createdAt,
          linkId: `link_${sessionId}`,
          orderId: sessionId,
          url: "https://sq.link",
        }),
      );
      await squarePaymentProvider.createCheckoutSession(
        intent({ "7": "Coming by bus" }),
        "https://site",
      );
      // The real create stages the cancel handle beside the answers; the
      // stub above replaces the create, so this stages what it would have.
      await stageSquareLinkEnd(
        sessionId,
        `link_${sessionId}`,
        squareLinkEndsAt(createdAt),
      );
      await execute(
        "UPDATE checkout_pending_answers SET created_at = ? WHERE session_index = ?",
        [createdAt, await hmacHash(sessionId)],
      );
      await execute(
        "UPDATE square_link_ends SET created_at = ? WHERE session_index = ?",
        [createdAt, await hmacHash(sessionId)],
      );
      await runDatabasePruning();
    };

    test("keeps a Square checkout's answers past the payments clock while its link can still take payment", async () => {
      await squareCheckoutAgedDays("sq_day_150", 150);

      expect(await takeCheckoutAnswers("sq_day_150")).toEqual(
        new Map([[7, "Coming by bus"]]),
      );
    });

    test("keeps a Square checkout's answers while a payment on the link's last day can still arrive", async () => {
      // The link ended a day ago, but a payment made just before its end can
      // still reach us through the provider's webhook retries.
      await squareCheckoutAgedDays("sq_day_181", 181);

      expect(await takeCheckoutAnswers("sq_day_181")).toEqual(
        new Map([[7, "Coming by bus"]]),
      );
    });

    test("prunes a Square checkout's answers once its link has ended and the webhook retries are over", async () => {
      await squareCheckoutAgedDays(
        "sq_day_184",
        180 + WEBHOOK_RETRY_WINDOW_DAYS + 1,
      );

      expect(await takeCheckoutAnswers("sq_day_184")).toEqual(new Map());
    });
  },
);
