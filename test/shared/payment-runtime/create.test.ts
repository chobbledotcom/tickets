import { expect } from "@std/expect";
import { afterEach, beforeEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { hmacHash } from "#shared/crypto/hashing.ts";
import { getDb } from "#shared/db/client.ts";
import {
  applyPaymentSessionClaim,
  claimPaymentSession,
} from "#shared/db/payments/claims.ts";
import {
  PAYMENT_STORAGE_CONTEXT,
  paymentStoredJson,
} from "#shared/db/payments/codecs.ts";
import { getPaymentSessions } from "#shared/db/payments/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import { extractSessionMetadata } from "#shared/payment-helpers.ts";
import { createPaymentCheckout } from "#shared/payment-runtime/create.ts";
import { paymentsApi, type SessionMetadata } from "#shared/payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { sumupApi } from "#shared/sumup.ts";
import { sumupPaymentProvider } from "#shared/sumup-provider.ts";
import {
  checkoutIntent,
  expectPaymentCheckoutCreationDue,
  stubProviderCheckout,
} from "#test-utils/checkout.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const stripeResource = {
  id: "cs_runtime",
  kind: "stripe_checkout_session" as const,
  provider: "stripe" as const,
};

describeWithEnv("payment runtime create", { db: true }, () => {
  beforeEach(() => {
    settings.setForTest({
      booking_fee: "0",
      currency: "GBP",
      payment_provider: "stripe",
      stripe_secret_key: "sk_test_runtime",
    });
  });

  afterEach(() => settings.clearTestOverrides());

  test("persists canonical payment facts before provider IO and attaches its exact resource", async () => {
    const started = Promise.withResolvers<PaymentCheckoutCreateSnapshot>();
    const release = Promise.withResolvers<void>();
    using create = stub(
      stripePaymentProvider,
      "createCheckout",
      async (checkout: PaymentCheckoutCreateSnapshot) => {
        started.resolve(checkout);
        await release.promise;
        return {
          checkoutUrl: "https://stripe.example/runtime",
          session: stripeResource,
          sessionId: stripeResource.id,
        };
      },
    );
    const intent = checkoutIntent({
      modifiers: [
        {
          id: 9,
          kind: "fixed",
          listingIds: null,
          name: "Fee",
          quantity: 2,
          trigger: "automatic",
          value: 50,
        },
      ],
      siteToken: "renew-secret",
    });

    const resultPromise = createPaymentCheckout(
      intent,
      "https://tickets.example",
    );
    const prepared = await started.promise;
    const before = (await getPaymentSessions([prepared.localPaymentId]))[0];
    const rawBefore = await getDb().execute({
      args: [prepared.localPaymentId],
      sql: `SELECT booking_intent, checkout_create
              FROM payment_sessions WHERE id = ?`,
    });

    expect(before).toMatchObject({
      bookingIntent: prepared.bookingIntent,
      checkoutCreate: prepared,
      expected: prepared.expected,
      id: prepared.localPaymentId,
      mode: "test",
      provider: "stripe",
      session: null,
      state: "created",
    });
    expect(prepared.expected).toEqual({ amount: 1_100, currency: "GBP" });
    expect(prepared.bookingIntent.modifiers).toEqual([{ i: 9, q: 2 }]);
    expect(prepared.bookingIntent.siteTokenIndex).toBe(
      await hmacHash("renew-secret"),
    );
    expect(String(rawBefore.rows[0]?.checkout_create)).toMatch(/^enc:1:/u);
    expect(JSON.stringify(rawBefore.rows[0])).not.toContain("renew-secret");
    const metadata = extractSessionMetadata(
      prepared.metadata as unknown as SessionMetadata,
    );
    expect(JSON.parse(metadata.items)).toEqual(prepared.bookingIntent.items);
    expect(JSON.parse(metadata.modifiers)).toEqual(
      prepared.bookingIntent.modifiers,
    );
    expect(Number(metadata.price_proof.split(".")[0])).toBe(
      prepared.expected.amount,
    );
    expect(metadata.price_proof.split(".")[1]).toBe(prepared.localPaymentId);

    release.resolve();
    expect(await resultPromise).toEqual({
      checkoutUrl: "https://stripe.example/runtime",
      sessionId: stripeResource.id,
    });
    const stored = (await getPaymentSessions([prepared.localPaymentId]))[0];
    expect(stored?.session).toEqual(stripeResource);
    expect(stored?.state).toBe("pending");
    expect(stored?.nextReconcileAt).not.toBeNull();
    expect(stored?.checkoutCreate).toBeNull();

    const raw = await getDb().execute({
      args: [prepared.localPaymentId],
      sql: `SELECT checkout_create, session_resource, session_reference_index
              FROM payment_sessions WHERE id = ?`,
    });
    expect(String(raw.rows[0]?.session_resource)).toMatch(/^enc:1:/u);
    expect(String(raw.rows[0]?.session_resource)).not.toContain(
      stripeResource.id,
    );
    expect(raw.rows[0]?.session_reference_index).toBe(
      await paymentStoredJson.sessionResource.index(
        stripeResource,
        PAYMENT_STORAGE_CONTEXT.sessionResource,
      ),
    );
    expect(raw.rows[0]?.checkout_create).toBeNull();
    expect(create.calls).toHaveLength(1);
  });

  test("keeps an uncertain provider creation due for reconciliation", async () => {
    const checkout = stubProviderCheckout(stripePaymentProvider, () =>
      Promise.resolve(null),
    );
    using _create = checkout.checkout;

    expect(
      await createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).toBeNull();
    await expectPaymentCheckoutCreationDue(
      checkout.requireCaptured().localPaymentId,
    );
  });

  test("keeps a thrown provider creation due before rethrowing", async () => {
    const checkout = stubProviderCheckout(stripePaymentProvider, () => {
      throw new Error("provider unavailable");
    });
    using _create = checkout.checkout;

    await expect(
      createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).rejects.toThrow("provider unavailable");
    await expectPaymentCheckoutCreationDue(
      checkout.requireCaptured().localPaymentId,
    );
  });

  test("stores a provider-rejected checkout as failed", async () => {
    const checkout = stubProviderCheckout(stripePaymentProvider, () =>
      Promise.resolve({ error: "Card details are invalid." }),
    );
    using _create = checkout.checkout;

    expect(
      await createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).toEqual({ error: "Card details are invalid." });
    expect(
      (
        await getPaymentSessions([checkout.requireCaptured().localPaymentId])
      )[0],
    ).toMatchObject({
      checkoutCreate: null,
      nextReconcileAt: null,
      session: null,
      state: "failed",
    });
  });

  test("rejects a wrong provider resource but keeps creation due", async () => {
    const checkout = stubProviderCheckout(stripePaymentProvider, () =>
      Promise.resolve({
        checkoutUrl: "https://square.example/wrong",
        session: {
          id: "square-order",
          kind: "square_order" as const,
          provider: "square" as const,
        },
        sessionId: "square-order",
      }),
    );
    using _create = checkout.checkout;

    await expect(
      createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).rejects.toThrow("Provider returned the wrong payment resource");
    const stored = (
      await getPaymentSessions([checkout.requireCaptured().localPaymentId])
    )[0];
    expect(stored).toMatchObject({
      session: null,
      state: "created",
    });
    expect(stored?.nextReconcileAt).not.toBeNull();
  });

  test("returns null when payments are disabled", async () => {
    using configured = stub(paymentsApi, "getConfiguredProvider", () => null);

    expect(
      await createPaymentCheckout(checkoutIntent(), "https://tickets.example"),
    ).toBeNull();
    expect(configured.calls).toHaveLength(1);
  });

  test("a stale provider response cannot overwrite a newer claim", async () => {
    const started = Promise.withResolvers<PaymentCheckoutCreateSnapshot>();
    const release = Promise.withResolvers<void>();
    using _create = stub(
      stripePaymentProvider,
      "createCheckout",
      async (checkout: PaymentCheckoutCreateSnapshot) => {
        started.resolve(checkout);
        await release.promise;
        return {
          checkoutUrl: "https://stripe.example/stale",
          session: stripeResource,
          sessionId: stripeResource.id,
        };
      },
    );
    const creation = createPaymentCheckout(
      checkoutIntent(),
      "https://tickets.example",
    );
    const prepared = await started.promise;
    await getDb().execute({
      args: [prepared.localPaymentId],
      sql: "UPDATE payment_sessions SET lease_expires_at = 0 WHERE id = ?",
    });
    const replacement = await claimPaymentSession(
      prepared.localPaymentId,
      60_000,
    );
    if (replacement === null) throw new Error("Expected replacement claim");
    const replacementResource = { ...stripeResource, id: "cs_replacement" };
    await applyPaymentSessionClaim(replacement, {
      attendeeId: null,
      completion: null,
      completionState: "none",
      nextReconcileAt: null,
      result: null,
      resultState: "none",
      session: replacementResource,
      state: "pending",
      ticketState: "none",
      ticketTokens: null,
    });

    release.resolve();
    await expect(creation).rejects.toThrow(
      `Lost payment session lease for ${prepared.localPaymentId}`,
    );
    expect(
      (await getPaymentSessions([prepared.localPaymentId]))[0]?.session,
    ).toEqual(replacementResource);
  });

  test("SumUp redirects with the local id and stores its returned checkout id", async () => {
    settings.setForTest({
      payment_provider: "sumup",
      sumup_api_key: "sk_test_sumup",
      sumup_merchant_code: "merchant-runtime",
    });
    let localPaymentId = "";
    using _create = stub(sumupApi, "createCheckout", (checkout) => {
      localPaymentId = checkout.localPaymentId;
      return Promise.resolve({
        id: "sumup-checkout-id",
        reference: checkout.localPaymentId,
        url: "https://sumup.example/checkout",
      });
    });

    const result = await createPaymentCheckout(
      checkoutIntent(),
      "https://tickets.example",
    );

    expect(result).toEqual({
      checkoutUrl: "https://sumup.example/checkout",
      sessionId: localPaymentId,
    });
    expect((await getPaymentSessions([localPaymentId]))[0]?.session).toEqual({
      id: "sumup-checkout-id",
      kind: "sumup_checkout",
      provider: "sumup",
    });
    expect(sumupPaymentProvider.type).toBe("sumup");
  });
});
