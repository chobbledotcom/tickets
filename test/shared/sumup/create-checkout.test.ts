import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { getSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import { createCheckout } from "#shared/sumup.ts";
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
      expect(await createCheckout(intent, "http://localhost")).toBeNull();
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
      const result = await createCheckout(intent, "http://localhost");
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
      await createCheckout(intent, "http://localhost");
      expect(sentBody.amount).toBe(2000);
      expect(sentBody.currency).toBe("CLP");
    });
  });

  test("returns null and says why when the response lacks an id", async () => {
    const client = makeSumupClient({
      create: () =>
        Promise.resolve({ hosted_checkout_url: "https://pay.sumup.com/z" }),
    });
    await withSumupClient(client, async () => {
      expect(await createCheckout(intent, "http://localhost")).toBeNull();
    });
    expect(
      loggedDebug("Checkout response missing id or hosted_checkout_url"),
    ).toBe(true);
  });

  test("returns null when the response lacks a hosted_checkout_url", async () => {
    const client = makeSumupClient({
      create: () => Promise.resolve({ id: "co_no_url" }),
    });
    await withSumupClient(client, async () => {
      expect(await createCheckout(intent, "http://localhost")).toBeNull();
    });
  });

  test("returns null when the client is unavailable", async () => {
    await withSumupClient(null, async () => {
      expect(await createCheckout(intent, "http://localhost")).toBeNull();
    });
  });
});
