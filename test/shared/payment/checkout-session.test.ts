/** The checkout-session factory stages a checkout's answers and their
 * snapshot beside the session id the provider hands back, in one write —
 * every checkout stages, so a paid session always has a row its tail can
 * resume from. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { readCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { makeCreateCheckoutSession } from "#payment/checkout-session.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
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
      expect((await readCheckoutAnswers("cs_staging"))?.texts.get(7)).toBe(
        "Coming by bus",
      );
    });

    test("stages a marker even when the buyer typed no free text", async () => {
      const calls = await countDatabaseCalls(1, () =>
        acceptingProvider(intent(), "https://site"),
      );

      expect(calls).toBe(1);
      expect(await readCheckoutAnswers("cs_staging")).toEqual({
        snapshot: [],
        texts: new Map(),
      });
    });
  },
);
