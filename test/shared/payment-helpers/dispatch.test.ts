import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import { ErrorCode } from "#shared/logger.ts";
import {
  cachedClientFactory,
  createWithClient,
  enforceMetadataLimits,
  hasRequiredSessionMetadata,
  PaymentUserError,
  parseWebhookPayload,
  safeAsync,
  toCheckoutResult,
  validatedPaymentSession,
} from "#shared/payment-helpers.ts";
import { isPaymentStatus } from "#shared/payments.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import "../../lib/payment-helpers/limits.test.ts";

describe("payment-helpers", () => {
  const errors = setupErrorSpy();

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
  });

  test("allows absent option fields when the value limit is zero", () => {
    expect(enforceMetadataLimits({}, 0)).toEqual({});
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

  describe("isPaymentStatus", () => {
    test("accepts valid statuses", () => {
      expect(isPaymentStatus("paid")).toBe(true);
      expect(isPaymentStatus("unpaid")).toBe(true);
      expect(isPaymentStatus("no_payment_required")).toBe(true);
    });

    test("rejects invalid values", () => {
      expect(isPaymentStatus("completed")).toBe(false);
      expect(isPaymentStatus("")).toBe(false);
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
      expect(new PaymentUserError("Bad phone").name).toBe("PaymentUserError");
      await expect(
        safeAsync(
          () => Promise.reject(new PaymentUserError("Bad phone")),
          ErrorCode.PAYMENT_CHECKOUT,
        ),
      ).rejects.toThrow("Bad phone");
    });

    test("logs the fallback detail for a non-Error failure", async () => {
      await safeAsync(
        () => Promise.reject("string error"),
        ErrorCode.PAYMENT_CHECKOUT,
      );
      expect(errors.contains("unknown")).toBe(true);
    });
  });

  describe("cachedClientFactory", () => {
    test("logs missing, created, and cached client states", async () => {
      setSuppressDebugLogs(false);
      using debug = spy(console, "debug");
      let config: string | null = null;
      const clients = cachedClientFactory({
        create: (key: string) => ({ key }),
        getConfig: () => config,
        isSameConfig: (left, right) => left === right,
        missingMessage: "Provider key is missing",
        provider: "Payment",
      });
      try {
        expect(await clients.getClient()).toBeNull();
        config = "key-1";
        expect(await clients.getClient()).toEqual({ key: "key-1" });
        expect(await clients.getClient()).toEqual({ key: "key-1" });
        const output = debug.calls
          .map((call) => String(call.args[0]))
          .join("\n");
        expect(output).toContain("Provider key is missing");
        expect(output).toContain("Creating new Payment client");
        expect(output).toContain("Using cached Payment client");
      } finally {
        setSuppressDebugLogs(null);
      }
    });

    test("keeps an explicitly empty creation message", async () => {
      setSuppressDebugLogs(false);
      using debug = spy(console, "debug");
      const clients = cachedClientFactory({
        create: () => ({}),
        createMessage: () => "",
        getConfig: () => "key",
        isSameConfig: () => true,
        missingMessage: "missing",
        provider: "Payment",
      });
      try {
        await clients.getClient();
        expect(debug.calls[0]!.args[0]).toBe("[Payment] ");
      } finally {
        setSuppressDebugLogs(null);
      }
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
      setSuppressDebugLogs(false);
      using debug = spy(console, "debug");
      try {
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
          toCheckoutResult(
            "",
            "https://pay.example.com",
            "Stripe",
            "checkout_1",
          ),
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
        expect(
          debug.calls.some((call) =>
            String(call.args[0]).includes(
              "Checkout result missing session ID, provider ID, or URL",
            ),
          ),
        ).toBe(true);
      } finally {
        setSuppressDebugLogs(null);
      }
    });
  });
});
