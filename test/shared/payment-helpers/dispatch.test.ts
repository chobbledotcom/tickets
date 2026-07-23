import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { ErrorCode } from "#shared/logger.ts";
import {
  cachedClientFactory,
  createWithClient,
  hasRequiredSessionMetadata,
  PaymentUserError,
  parseWebhookPayload,
  safeAsync,
  toCheckoutResult,
  validatedPaymentSession,
} from "#shared/payment-helpers.ts";
import { debugMessages, useDebugLogSpy } from "#test-utils/debug-log.ts";

describe("payment-helpers", () => {
  const debugSpy = useDebugLogSpy();

  describe("hasRequiredSessionMetadata", () => {
    test("returns false for null/undefined", () => {
      expect(hasRequiredSessionMetadata(null)).toBe(false);
      expect(hasRequiredSessionMetadata(undefined)).toBe(false);
    });

    test("returns false when name is missing or empty", () => {
      expect(
        hasRequiredSessionMetadata({ email: "a@b.com", items: "[]" }),
      ).toBe(false);
      expect(
        hasRequiredSessionMetadata({
          email: "a@b.com",
          items: "[]",
          name: "",
        }),
      ).toBe(false);
    });

    test("returns false when items missing", () => {
      expect(
        hasRequiredSessionMetadata({ email: "a@b.com", name: "Alice" }),
      ).toBe(false);
    });

    test("returns true for valid single-listing (email optional)", () => {
      expect(hasRequiredSessionMetadata({ items: "[]", name: "Alice" })).toBe(
        true,
      );
      expect(
        hasRequiredSessionMetadata({ email: "", items: "[]", name: "Alice" }),
      ).toBe(true);
    });

    test("returns true for valid multi-listing metadata", () => {
      expect(
        hasRequiredSessionMetadata({
          email: "a@b.com",
          items: '[{"e":1,"q":2,"p":2000}]',
          name: "Alice",
        }),
      ).toBe(true);
    });

    test("returns false when a present metadata value is not text", () => {
      expect(
        hasRequiredSessionMetadata({
          email: 123 as unknown as string,
          items: "[]",
          name: "Alice",
        }),
      ).toBe(false);
    });
  });

  test("includes only usable provider creation timestamps", () => {
    const metadata = { items: "[]", name: "Buyer" };
    if (!hasRequiredSessionMetadata(metadata)) {
      throw new Error("Test payment metadata must be valid");
    }
    const fields = {
      amountTotal: 100,
      id: "session-1",
      metadata,
      paymentReference: "payment-1",
      paymentStatus: "paid" as const,
    };
    expect(
      validatedPaymentSession({
        ...fields,
        createdAt: "2026-07-18T00:00:00.000Z",
      }).createdAt,
    ).toBe("2026-07-18T00:00:00.000Z");
    expect(
      "createdAt" in
        validatedPaymentSession({
          ...fields,
          createdAt: undefined,
        }),
    ).toBe(false);
  });

  test("returns the exact invalid JSON webhook error", () => {
    expect(parseWebhookPayload("{bad", ErrorCode.PAYMENT_SIGNATURE)).toEqual({
      error: "Invalid JSON payload",
      valid: false,
    });
  });
  describe("safeAsync", () => {
    test("returns value on success, null on error", async () => {
      expect(
        await safeAsync(() => Promise.resolve(42), ErrorCode.PAYMENT_CHECKOUT),
      ).toBe(42);
      expect(
        await safeAsync(
          () => Promise.reject(new Error("boom")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
      expect(
        await safeAsync(
          () => Promise.reject("string error"),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
    });

    test("re-throws PaymentUserError", async () => {
      const error = new PaymentUserError("Bad phone");
      expect(error.name).toBe("PaymentUserError");
      await expect(
        safeAsync(() => Promise.reject(error), ErrorCode.PAYMENT_CHECKOUT),
      ).rejects.toThrow("Bad phone");
    });

    test("logs unknown for a non-Error rejection", async () => {
      const errorSpy = spy(console, "error");
      try {
        await safeAsync(
          () => Promise.reject("string error"),
          ErrorCode.PAYMENT_CHECKOUT,
        );
        expect(errorSpy.calls[0]?.args[0]).toBe(
          '[Error] E_PAYMENT_CHECKOUT detail="unknown"',
        );
      } finally {
        errorSpy.restore();
      }
    });
  });

  describe("cachedClientFactory", () => {
    test("logs missing configuration and the chosen creation message", async () => {
      let config: string | null = null;
      const cache = cachedClientFactory({
        create: (value: string) => ({ value }),
        createMessage: () => "",
        getConfig: () => config,
        isSameConfig: (a, b) => a === b,
        missingMessage: "No secret key configured",
        provider: "Stripe",
      });

      expect(await cache.getClient()).toBeNull();
      config = "secret";
      expect(await cache.getClient()).toEqual({ value: "secret" });
      expect(debugMessages(debugSpy())).toEqual([
        "[Stripe] No secret key configured",
        "[Stripe] ",
      ]);
    });

    test("reuses and logs the cached client", async () => {
      const client = { value: "secret" };
      let createCalls = 0;
      const cache = cachedClientFactory({
        create: () => {
          createCalls += 1;
          return client;
        },
        getConfig: () => "secret",
        isSameConfig: (a, b) => a === b,
        missingMessage: "No secret key configured",
        provider: "Stripe",
      });

      expect(await cache.getClient()).toBe(client);
      expect(await cache.getClient()).toBe(client);
      expect(createCalls).toBe(1);
      expect(debugMessages(debugSpy())).toEqual([
        "[Stripe] Creating new Stripe client",
        "[Stripe] Using cached Stripe client",
      ]);
    });
  });

  describe("createWithClient", () => {
    test("returns null when client is null", async () => {
      const withClient = createWithClient(() => Promise.resolve(null));
      const result = await withClient(
        () => Promise.resolve("value"),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(result).toBeNull();
    });

    test("passes client to operation", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      expect(
        await withClient(
          (c) => Promise.resolve(`got-${c.token}`),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBe("got-abc");
    });

    test("returns null on operation error, re-throws PaymentUserError", async () => {
      const withClient = createWithClient(() =>
        Promise.resolve({ token: "abc" }),
      );
      expect(
        await withClient(
          () => Promise.reject(new Error("fail")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).toBeNull();
      await expect(
        withClient(
          () => Promise.reject(new PaymentUserError("Phone invalid")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).rejects.toThrow("Phone invalid");
    });

    test("propagates errors selected by the provider", async () => {
      const protocolError = new TypeError("Malformed provider response");
      const withClient = createWithClient(
        () => Promise.resolve({ token: "abc" }),
        { shouldPropagate: (error) => error === protocolError },
      );

      await expect(
        withClient(
          () => Promise.reject(protocolError),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).rejects.toBe(protocolError);
    });
  });

  describe("toCheckoutResult", () => {
    test("returns result when both id and url present", () => {
      expect(
        toCheckoutResult(
          "sess_1",
          "https://pay.example.com",
          "Stripe",
          "checkout_1",
        ),
      ).toEqual({
        checkoutUrl: "https://pay.example.com",
        providerCheckoutId: "checkout_1",
        sessionId: "sess_1",
      });
    });

    test("returns null for missing or empty id/url", () => {
      expect(
        toCheckoutResult(
          undefined,
          "https://pay.example.com",
          "Stripe",
          "checkout_1",
        ),
      ).toBeNull();
      expect(
        toCheckoutResult("sess_1", undefined, "Stripe", "checkout_1"),
      ).toBeNull();
      expect(
        toCheckoutResult("sess_1", null, "Stripe", "checkout_1"),
      ).toBeNull();
      expect(
        toCheckoutResult("", "https://pay.example.com", "Stripe", "checkout_1"),
      ).toBeNull();
      expect(
        toCheckoutResult("sess_1", "", "Payment", "checkout_1"),
      ).toBeNull();
      expect(
        toCheckoutResult(
          "sess_1",
          "https://pay.example.com",
          "Stripe",
          undefined,
        ),
      ).toBeNull();
      expect(debugSpy().calls[0]?.args[0]).toBe(
        "[Stripe] Checkout result missing session ID, provider ID, or URL",
      );
    });
  });
});
