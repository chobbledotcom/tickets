import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import {
  classifySession,
  classifySessionIntent,
  paymentSessionErrorLogger,
  validateConfirmedPaidSession,
  validatePaidSession,
  validateRefreshedPaidSession,
} from "#routes/api/payment-processing/classify.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { signedMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

const session = (
  metadata: ReturnType<typeof webhookMeta>,
  amountTotal = 1000,
) => ({
  amountTotal,
  id: "classified-session",
  metadata,
  paymentReference: "payment-reference",
  paymentStatus: "paid" as const,
});

describeWithEnv("payment session classification", { db: true }, () => {
  test("classifies valid matching and mismatched signed totals", async () => {
    const metadata = signedMeta(
      { items: singleItem(7, 1, 1000), name: "Buyer" },
      1000,
    );
    expect(await classifySession(session(metadata))).toEqual({
      agreed: 1000,
      verdict: "trusted",
    });
    expect(await classifySession(session(metadata, 999))).toEqual({
      agreed: 1000,
      verdict: "mismatch",
    });
  });

  for (const priceProof of ["", "broken", "1000.bad-signature"]) {
    test(`ignores the untrusted proof ${priceProof || "missing"}`, async () => {
      const metadata = webhookMeta({
        items: singleItem(7, 1, 1000),
        name: "Buyer",
        price_proof: priceProof,
      });
      expect(await classifySession(session(metadata))).toEqual({
        verdict: "ignore",
      });
      expect(await classifySessionIntent(session(metadata))).toBeNull();
    });
  }

  test("returns the parsed intent with a trusted verdict", async () => {
    const metadata = signedMeta(
      { items: singleItem(7, 1, 1000), name: "Buyer" },
      1000,
    );
    expect(await classifySessionIntent(session(metadata))).toMatchObject({
      intent: { items: [{ e: 7, p: 1000, q: 1 }] },
      verdict: { agreed: 1000, verdict: "trusted" },
    });
    expect(await validateConfirmedPaidSession(session(metadata))).toMatchObject(
      { ok: true },
    );
  });

  test("rejects an unrecognized confirmed session", async () => {
    const logs: unknown[][] = [];
    using _error = stub(console, "error", (...args) => logs.push(args));
    const result = await validateConfirmedPaidSession(
      session(webhookMeta({ name: "Buyer" })),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(await result.response.text()).toContain(
        "Payment session not recognized",
      );
    expect(String(logs[0]?.[0])).toContain("Unrecognized payment session");
  });

  test("refreshes a newly readable paid session", async () => {
    const metadata = signedMeta(
      { items: singleItem(7, 1, 1000), name: "Buyer" },
      1000,
    );
    using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve(session(metadata)),
    );
    expect(
      await validateRefreshedPaidSession(
        "classified-session",
        stripePaymentProvider,
      ),
    ).toMatchObject({ ok: true });
  });

  for (const refreshed of [null, session(webhookMeta({ name: "Buyer" }))]) {
    test(`returns 503 when refreshed paid state is ${refreshed === null ? "missing" : "not paid"}`, async () => {
      const logs: unknown[][] = [];
      using _error = stub(console, "error", (...args) => logs.push(args));
      const value =
        refreshed === null
          ? null
          : { ...refreshed, paymentStatus: "unpaid" as const };
      using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
        Promise.resolve(value),
      );
      const result = await validateRefreshedPaidSession(
        "classified-session",
        stripePaymentProvider,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.response.status).toBe(503);
        expect(await result.response.text()).toContain("Please try again");
      }
      expect(String(logs[0]?.[0])).toContain("Paid checkout not yet readable");
      if (refreshed === null)
        expect(String(logs[0]?.[0])).toContain("status=missing");
    });
  }

  test("builds a callable step-prefixed logger", () => {
    const calls: unknown[][] = [];
    using _error = stub(console, "error", (...args) => calls.push(args));
    paymentSessionErrorLogger("test-step")("detail");
    expect(String(calls[0]?.[0])).toContain("[test-step] detail");
  });

  test("reports a missing provider", async () => {
    const logs: unknown[][] = [];
    using _error = stub(console, "error", (...args) => logs.push(args));
    const result = await validatePaidSession("missing-provider");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(await result.response.text()).toContain(
        "Payment provider not configured",
      );
    expect(String(logs[0]?.[0])).toContain("[redirect] No payment provider");
  });

  test("reports a missing provider session", async () => {
    await setupStripe();
    using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve(null),
    );
    const logs: unknown[][] = [];
    using _error = stub(console, "error", (...args) => logs.push(args));
    const result = await validatePaidSession("missing-session");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(await result.response.text()).toContain(
        "Payment session not found",
      );
    expect(String(logs[0]?.[0])).toContain("Session not found");
  });

  test("reports a session that is not paid", async () => {
    await setupStripe();
    using _retrieve = stub(stripePaymentProvider, "retrieveSession", () =>
      Promise.resolve({
        ...session(webhookMeta({ name: "Buyer" })),
        paymentStatus: "unpaid" as const,
      }),
    );
    const logs: unknown[][] = [];
    using _error = stub(console, "error", (...args) => logs.push(args));
    const result = await validatePaidSession("pending-session");
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(await result.response.text()).toContain("Please contact support");
    expect(String(logs[0]?.[0])).toContain("Payment not verified as paid");
  });
});
