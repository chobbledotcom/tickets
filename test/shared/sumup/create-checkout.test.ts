import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { getSumupCheckout } from "#db/sumup-checkouts.ts";
import { providerDetail, transportError } from "#payment/transport-error.ts";
import { sumupApi } from "#shared/sumup.ts";
import {
  expectClosedCheckoutFailure,
  expectSameThrown,
} from "#test-utils/checkout-failure.ts";
import {
  makeSumupClient,
  setupSumupSuite,
  withSumupClient,
} from "#test-utils/sumup.ts";

const intent = {
  address: "",
  date: null,
  email: "alice@example.com",
  items: [
    { listingId: 1, name: "Evt", quantity: 2, slug: "evt", unitPrice: 1000 },
  ],
  name: "Alice",
  phone: "",
  special_instructions: "",
};

describe("sumup createCheckout", () => {
  const { loggedDebug } = setupSumupSuite();

  test("returns null and stores no orphan when merchant code is absent", async () => {
    settings.setForTest({ sumup_merchant_code: "" });
    const client = makeSumupClient({ create: () => Promise.resolve({}) });
    await withSumupClient(client, async () => {
      expect(
        await sumupApi.createCheckout(intent, "http://localhost"),
      ).toBeNull();
    });
  });

  test("creates a hosted checkout, converts the total, and persists metadata + id", async () => {
    let sentBody: Record<string, unknown> = {};
    const client = makeSumupClient({
      create: (body) => {
        sentBody = body as Record<string, unknown>;
        return Promise.resolve({
          checkout_reference: sentBody.checkout_reference,
          hosted_checkout_url: "https://pay.sumup.com/x",
          id: "co_created",
          status: "PENDING",
        });
      },
    });
    await withSumupClient(client, async () => {
      const result = await sumupApi.createCheckout(intent, "http://localhost");
      expect(result).not.toBeNull();
      expect(result!.url).toBe("https://pay.sumup.com/x");
      // 2 tickets * 1000 minor units = 2000 minor => 20 major units
      expect(sentBody.amount).toBe(20);
      expect(sentBody.currency).toBe("GBP");
      expect(sentBody.hosted_checkout).toEqual({ enabled: true });
      expect(sentBody.merchant_code).toBe("MC123");
      expect(String(sentBody.redirect_url)).toContain(
        `session_id=${result!.reference}`,
      );
      expect(sentBody.return_url).toBe("https://example.com/payment/webhook");
      // Metadata + SumUp id persisted under the generated reference
      const stored = await getSumupCheckout(result!.reference);
      expect(stored!.metadata.name).toBe("Alice");
      expect(stored!.sumupId).toBe("co_created");
    });
  });

  test("logs the created checkout's own id", async () => {
    // The payment-sandbox story reads this line to deliver the callback for
    // the checkout it just made, so the id has to be in it.
    const client = makeSumupClient({
      create: () =>
        Promise.resolve({
          hosted_checkout_url: "https://pay.sumup.com/x",
          id: "co_logged",
        }),
    });
    await withSumupClient(client, async () => {
      await sumupApi.createCheckout(intent, "http://localhost");
      expect(loggedDebug("Checkout created id=co_logged")).toBe(true);
    });
  });

  const checkoutFailure = async (providerError: unknown): Promise<unknown> => {
    const client = makeSumupClient({
      create: () => Promise.reject(providerError),
    });
    let result: Promise<unknown> = Promise.resolve();
    await withSumupClient(client, async () => {
      result = sumupApi.createCheckout(intent, "http://localhost");
      await result.catch(() => undefined);
    });
    return result;
  };

  test("closes SumUp API bodies before they reach diagnostics", async () => {
    const privateBody = "buyer private.person@example.com checkout co_private";
    const providerError = transportError.answered(
      providerDetail.sumup(),
      422,
      privateBody,
    );
    await expectClosedCheckoutFailure(
      checkoutFailure(providerError),
      { provider: "sumup", reason: "provider_error", statusCode: 422 },
      [privateBody],
      providerError,
    );
  });

  test("closes SumUp network failures", async () => {
    const privateMessage = "network failed beside checkout co_private";
    const providerError = transportError.unreachable(
      providerDetail.sumup(),
      "network_error",
      privateMessage,
    );
    await expectClosedCheckoutFailure(
      checkoutFailure(providerError),
      { provider: "sumup", reason: "network_error" },
      [privateMessage],
      providerError,
    );
  });

  test("closes SumUp checkout timeouts", async () => {
    const privateMessage = "timed out beside checkout co_private";
    const providerError = transportError.unreachable(
      providerDetail.sumup(),
      "timeout",
      privateMessage,
    );
    await expectClosedCheckoutFailure(
      checkoutFailure(providerError),
      { provider: "sumup", reason: "timeout" },
      [privateMessage],
      providerError,
    );
  });

  test("closes malformed SumUp checkout responses", async () => {
    const providerError = transportError.unusable(providerDetail.sumup());
    await expectClosedCheckoutFailure(
      checkoutFailure(providerError),
      { provider: "sumup", reason: "invalid_response" },
      [],
      providerError,
    );
  });

  test("does not relabel a raw transport failure the transport did not name", async () => {
    const raw = new TypeError("network failed beside checkout co_private");
    await expectSameThrown(checkoutFailure(raw), raw);
  });

  test("does not relabel an internal SumUp checkout failure", async () => {
    const applicationError = new Error("SumUp checkout mapper bug");
    await expectSameThrown(checkoutFailure(applicationError), applicationError);
  });

  test("derives the major-unit amount from the configured currency", async () => {
    // CLP is a SumUp-supported zero-decimal currency: 2000 stays 2000.
    settings.setForTest({ currency: "CLP" });
    let sentBody: Record<string, unknown> = {};
    const client = makeSumupClient({
      create: (body) => {
        sentBody = body as Record<string, unknown>;
        return Promise.resolve({
          hosted_checkout_url: "https://pay.sumup.com/y",
          id: "co_clp",
          status: "PENDING",
        });
      },
    });
    await withSumupClient(client, async () => {
      await sumupApi.createCheckout(intent, "http://localhost");
      expect(sentBody.amount).toBe(2000);
      expect(sentBody.currency).toBe("CLP");
    });
  });

  test("throws when the response lacks an id", async () => {
    const client = makeSumupClient({
      create: () =>
        Promise.resolve({ hosted_checkout_url: "https://pay.sumup.com/z" }),
    });
    await withSumupClient(client, async () => {
      await expect(
        sumupApi.createCheckout(intent, "http://localhost"),
      ).rejects.toThrow("SumUp checkout response is missing its id");
    });
  });

  test("throws when the response lacks a hosted checkout URL", async () => {
    const client = makeSumupClient({
      create: () => Promise.resolve({ id: "co_no_url" }),
    });
    await withSumupClient(client, async () => {
      await expect(
        sumupApi.createCheckout(intent, "http://localhost"),
      ).rejects.toThrow("SumUp checkout response is missing its hosted URL");
    });
  });

  test("returns null when the client is unavailable", async () => {
    await withSumupClient(null, async () => {
      expect(
        await sumupApi.createCheckout(intent, "http://localhost"),
      ).toBeNull();
    });
  });
});
