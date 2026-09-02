import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { SessionRejection } from "#payment/validated-session.ts";
import {
  classifySession,
  classifySessionIntent,
  validatePaidSession,
} from "#routes/api/payment-processing/classify.ts";
import type {
  SessionMetadata,
  ValidatedPaymentSession,
} from "#shared/payments.ts";
import { runWithPendingWork } from "#shared/pending-work.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { getTestSession, requestAsSession } from "#test-utils/session.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  answerCompletedStripeRefund,
  stripeRefundRequestShape,
} from "#test-utils/stripe/fixtures.ts";
import { foundStripeIntent } from "#test-utils/stripe/responses.ts";

/** Makes the provider answer with this checkout — or with nothing, for a
 *  checkout it has never heard of — for as long as the test runs. */
const providerAnswers = async (
  answer: ValidatedPaymentSession | SessionRejection | null,
): Promise<Disposable> => {
  const { stub } = await import("@std/testing/mock");
  const { stripePaymentProvider } = await import("#shared/stripe-provider.ts");
  return stub(stripePaymentProvider, "retrieveSession", () =>
    Promise.resolve(answer),
  );
};

/** A paid checkout for one ticket at the given price, with a price proof made
 *  with this site's own key unless the caller replaces it. */
const paidSession = (
  metadata: Partial<SessionMetadata> = {},
  amountTotal = 500,
  currency = "GBP",
): ValidatedPaymentSession => ({
  amountTotal,
  currency,
  id: "cs_classify",
  metadata: {
    ...signedMeta(
      {
        email: "buyer@example.com",
        items: singleItem(1, 1, 500),
        name: "Buyer",
      },
      500,
    ),
    ...metadata,
  },
  paymentReference: "pi_classify",
  paymentStatus: "paid",
  provider: "stripe",
});

describeWithEnv("telling whether a checkout is ours", { db: true }, () => {
  test("trusts a checkout whose proof and amount both agree", async () => {
    await setupStripe();

    expect(await classifySession(paidSession())).toEqual({
      agreed: 500,
      verdict: "trusted",
    });
  });

  test("calls it a mismatch when the provider charged something else", async () => {
    // The proof is ours, so the checkout is ours — but the money taken is not
    // the money we signed for, which is a refund rather than a booking.
    await setupStripe();

    expect(await classifySession(paidSession({}, 900))).toEqual({
      agreed: 500,
      verdict: "mismatch",
    });
  });

  test("calls it a mismatch when the provider charged in another currency", async () => {
    // The proof is ours and the amount matches, but a charge in a different
    // currency cannot be honored at the signed total — it must be refunded,
    // not booked, so the captured money is never stranded.
    await setupStripe();

    expect(await classifySession(paidSession({}, 500, "USD"))).toEqual({
      agreed: 500,
      verdict: "mismatch",
    });
  });

  // Without a proof we cannot show the checkout is ours, and acting on one that
  // is not would move somebody else's money.
  for (const [name, priceProof] of [
    ["carries no proof at all", ""],
    ["carries a proof in no shape we write", "not-a-proof"],
    ["carries a proof with no signature", "500."],
    ["carries a proof signed by somebody else", "500.deadbeef"],
    ["carries a proof for a different total", "900.deadbeef"],
  ] as const) {
    test(`ignores a checkout that ${name}`, async () => {
      await setupStripe();

      expect(
        await classifySession(paidSession({ price_proof: priceProof })),
      ).toEqual({ verdict: "ignore" });
    });
  }
});

describeWithEnv("reading the booking out of a checkout", { db: true }, () => {
  test("hands back the verdict and the booking together", async () => {
    await setupStripe();

    const classified = await classifySessionIntent(paidSession());

    expect(classified.kind).toBe("ready");
    if (classified.kind !== "ready") throw new Error("Expected ready booking");
    expect(classified.verdict).toEqual({ agreed: 500, verdict: "trusted" });
    expect(classified.intent.items).toEqual([{ e: 1, p: 500, q: 1 }]);
  });

  test("says nothing about a checkout we cannot show is ours", async () => {
    await setupStripe();

    expect(
      await classifySessionIntent(paidSession({ price_proof: "" })),
    ).toEqual({ kind: "unverifiable" });
  });

  test("raises a checkout that is ours but whose booking will not read", async () => {
    // The buyer has been charged and we can prove the checkout is ours, so
    // silence would leave them with nothing and nobody looking.
    await setupStripe();

    // Raising it writes to the log the way a request does, so the test runs
    // in the same kind of scope a request gives it.
    const classified = await runWithPendingWork(() =>
      classifySessionIntent(
        paidSession(
          signedMeta(
            {
              email: "buyer@example.com",
              items: singleItem(1, 1, 500),
              modifiers: "{}",
              name: "Buyer",
            },
            500,
          ),
        ),
      ),
    );

    expect(classified).toEqual({ kind: "unreadable" });

    expect(
      await loggedAbout(
        "booking",
        "Signed payment's booking could not be read",
      ),
    ).toBe(true);
  });
});

/** Whether the owner's log carries this message, under the step it happened
 *  on. The step prefix is part of what the owner reads, so it is asserted
 *  rather than skipped over. */
const loggedAbout = async (step: string, words: string): Promise<boolean> =>
  (await getAllActivityLog()).some((entry) =>
    entry.message.includes(`[${step}] ${words}`),
  );

describeWithEnv("checking a checkout before it is used", { db: true }, () => {
  test("refuses when no payment provider is set up", async () => {
    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_no_provider"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    expect(await result.response.text()).toContain(
      "Payment provider not configured",
    );
    expect(
      await loggedAbout("redirect", "No payment provider configured"),
    ).toBe(true);
  });

  test("refuses a checkout the provider has never heard of", async () => {
    await setupStripe();
    using _provider = await providerAnswers(null);

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_missing"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    expect(await result.response.text()).toContain(
      "We could not find this payment session.",
    );
    expect(await loggedAbout("redirect", "Session not found")).toBe(true);
  });

  test("keeps a signed checkout retryable when its booking cannot be read", async () => {
    await setupStripe();
    using _provider = await providerAnswers(
      paidSession(
        signedMeta(
          {
            email: "buyer@example.com",
            items: singleItem(1, 1, 500),
            modifiers: "{}",
            name: "Buyer",
          },
          500,
        ),
      ),
    );

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_unreadable_booking"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the unreadable booking to refuse");
    expect(result.response.status).toBe(503);
    expect(await result.response.text()).toContain(
      "Payment verification failed. Please contact support.",
    );
  });

  test("tells a buyer whose unreadable charge was refunded", async () => {
    await setupStripe();
    const { stripeApi } = await import("#shared/stripe.ts");
    const { stub } = await import("@std/testing/mock");
    using _provider = await providerAnswers({
      metadata: signedMeta(
        { email: "refunded@example.com", items: "[]", name: "Refunded" },
        500,
      ),
      paymentReference: "pi_refunded",
      provider: "stripe",
      reason: "malformed_charge",
      refundable: true,
      sessionId: "cs_refunded",
    });
    using refundStub = stub(
      stripeApi,
      "refundCharge",
      answerCompletedStripeRefund(),
    );
    using _read = stub(stripeApi, "readPaymentIntent", (reference) =>
      Promise.resolve(foundStripeIntent(reference, 500)),
    );

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_refunded"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    // They really were charged, so "not found" would leave them waiting for a
    // ticket, or paying a second time.
    const page = await result.response.text();
    expect(page).toContain("We have sent your money back");
    expect(refundStub.calls.map((call) => call.args)).toEqual([
      [stripeRefundRequestShape("pi_refunded", 500)],
    ]);
    expect(page).not.toContain("We could not find this payment session.");
    expect(
      await loggedAbout(
        "redirect",
        "Session rejected as malformed_charge (session=cs_refunded, refunded: true)",
      ),
    ).toBe(true);
  });

  // A card that was declined and a buyer who changed their mind come back the
  // same way on some providers, so both get the friendly page rather than an
  // error telling them to contact support.
  test("shows the cancelled page when the checkout failed", async () => {
    await setupStripe();
    using _provider = await providerAnswers({
      amountTotal: 0,
      currency: "GBP",
      id: "cs_failed",
      metadata: webhookMeta({
        items: singleItem(99999, 1, 0),
        name: "Declined",
      }),
      paymentReference: "",
      paymentStatus: "failed" as const,
      provider: "stripe" as const,
    });

    const result = await validatePaidSession("cs_failed");

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    // The listing is gone, so the page says so rather than offering a retry.
    expect(await result.response.text()).toContain("Listing not found");
  });

  test("refuses a checkout the provider does not call paid", async () => {
    await setupStripe();
    using _provider = await providerAnswers({
      amountTotal: 500,
      currency: "GBP",
      id: "cs_unpaid",
      metadata: webhookMeta({ name: "Still Going" }),
      paymentReference: "",
      paymentStatus: "unpaid" as const,
      provider: "stripe" as const,
    });

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_unpaid"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    expect(await result.response.text()).toContain(
      "Payment verification failed",
    );
    expect(await loggedAbout("redirect", "Payment not verified as paid")).toBe(
      true,
    );
  });

  test("refuses a paid checkout we cannot show is ours", async () => {
    await setupStripe();
    using _provider = await providerAnswers(paidSession({ price_proof: "" }));

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_foreign"),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    expect(await result.response.text()).toContain(
      "Payment session not recognized",
    );
    expect(await loggedAbout("redirect", "Unrecognized payment session")).toBe(
      true,
    );
  });

  test("passes on the checkout, its verdict, and its booking", async () => {
    await setupStripe();
    using _provider = await providerAnswers(paidSession());

    const result = await validatePaidSession("cs_classify");

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected the check to pass");
    expect(result.data.session.id).toBe("cs_classify");
    expect(result.data.verdict).toEqual({ agreed: 500, verdict: "trusted" });
    expect(result.data.intent.items).toEqual([{ e: 1, p: 500, q: 1 }]);
  });
});

describeWithEnv("showing an owner why a checkout failed", { db: true }, () => {
  /** The provider answers with the checkout TICKETS-84 saw: still unpaid
   *  when its redirect landed. */
  const unpaidAnswers = async (): Promise<Disposable> =>
    providerAnswers({
      amountTotal: 500,
      currency: "GBP",
      id: "cs_unpaid",
      metadata: webhookMeta({ name: "Still Going" }),
      paymentReference: "",
      paymentStatus: "unpaid" as const,
      provider: "stripe" as const,
    });

  const ownerRequest = async (): Promise<Request> =>
    requestAsSession("/payment/success", await getTestSession());

  /** The refusing check's failure page, with its guard applied. */
  const refusedPage = async (
    result: Awaited<ReturnType<typeof validatePaidSession>>,
  ): Promise<string> => {
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected the check to refuse");
    return await result.response.text();
  };

  test("hands an owner the diagnostics beside the refusal", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();

    const result = await runWithPendingWork(async () =>
      validatePaidSession("cs_unpaid", await ownerRequest()),
    );

    const page = await refusedPage(result);
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("cs_unpaid");
    expect(page).toContain("unpaid");
    expect(page).toContain("3-D Secure");
  });

  test("keeps the buyer's page free of staff detail", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();

    const result = await runWithPendingWork(() =>
      validatePaidSession("cs_unpaid"),
    );

    const page = await refusedPage(result);
    expect(page).toContain("Payment verification failed");
    expect(page).not.toContain("Staff diagnostics");
  });

  test("shows the panel to the owner alone", async () => {
    await setupStripe();
    using _provider = await unpaidAnswers();
    const { createTestEditorSession } = await import("#test-utils/session.ts");
    const editorCookie = (await createTestEditorSession()).cookie;

    const result = await runWithPendingWork(async () =>
      validatePaidSession(
        "cs_unpaid",
        new Request("http://localhost/payment/success", {
          headers: { cookie: editorCookie },
        }),
      ),
    );

    const page = await refusedPage(result);
    expect(page).toContain("Payment verification failed");
    expect(page).not.toContain("Staff diagnostics");
  });

  test("names what it knows when no provider is configured", async () => {
    const result = await runWithPendingWork(async () =>
      validatePaidSession("cs_no_provider", await ownerRequest()),
    );

    const page = await refusedPage(result);
    expect(page).toContain("Staff diagnostics");
    expect(page).toContain("cs_no_provider");
    expect(page).not.toContain("Provider stripe");
  });
});
