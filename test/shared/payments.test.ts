import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setSuppressDebugLogs } from "#shared/log-settings.ts";
import {
  checkoutItem,
  getActivePaymentProvider,
  getPaymentProviderForExistingPayments,
  paymentsApi,
} from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testListing } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

describe("checkoutItem terms", () => {
  test("carries the plan's initial term for an assigned-site listing", () => {
    const plan = testListing({
      assign_built_site: true,
      initial_site_months: 3,
      name: "(3 Months)",
      slug: "p3m",
    });
    expect(checkoutItem(plan, 2, 4500)).toEqual({
      initialSiteMonths: 3,
      listingId: plan.id,
      name: "(3 Months)",
      quantity: 2,
      slug: "p3m",
      unitPrice: 4500,
    });
  });

  test("keeps an ordinary listing a ticket line", () => {
    const listing = testListing({ name: "Gala", slug: "gala" });
    expect(checkoutItem(listing, 3, 1000)).toEqual({
      listingId: listing.id,
      name: "Gala",
      quantity: 3,
      slug: "gala",
      unitPrice: 1000,
    });
    expect(
      Object.hasOwn(checkoutItem(listing, 3, 1000), "initialSiteMonths"),
    ).toBe(false);
  });

  test("carries no term when the stated initial months are zero", () => {
    const listing = testListing({
      assign_built_site: true,
      initial_site_months: 0,
      name: "Zero",
      slug: "zero",
    });
    expect(
      Object.hasOwn(checkoutItem(listing, 1, 0), "initialSiteMonths"),
    ).toBe(false);
  });

  test("carries no term when the initial months are unstated", () => {
    const listing = testListing({
      assign_built_site: true,
      name: "Unstated",
      slug: "unst",
    });
    delete (listing as { initial_site_months?: number }).initial_site_months;
    expect(
      Object.hasOwn(checkoutItem(listing, 1, 0), "initialSiteMonths"),
    ).toBe(false);
  });
});

describeWithEnv("provider resolution labels", { db: true }, () => {
  test("resolves no provider when settings configure none", async () => {
    const missing = stub(paymentsApi, "getConfiguredProvider", () => null);
    const noneConfigured: string[] = [];
    const debug = stub(console, "debug", (line: unknown) => {
      const text = String(line);
      if (text.includes("No payment provider configured in settings")) {
        noneConfigured.push(text);
      }
    });
    setSuppressDebugLogs(false);
    try {
      await expect(getActivePaymentProvider()).resolves.toBeNull();
      await expect(getPaymentProviderForExistingPayments()).resolves.toBeNull();
      // The active route — and only that route — names the missing provider:
      // an existing-payment lookup resolves first and stays silent.
      expect(noneConfigured).toHaveLength(1);
    } finally {
      missing.restore();
      debug.restore();
      setSuppressDebugLogs(null);
    }
  });

  test("logs each lookup under its own route's words", async () => {
    await setupStripe();
    const logged: string[] = [];
    const debug = stub(console, "debug", (line: unknown) => {
      logged.push(String(line));
    });
    setSuppressDebugLogs(false);
    try {
      await getActivePaymentProvider();
      await getPaymentProviderForExistingPayments();
      expect(
        logged.some((line) =>
          line.includes("[Payment] Resolving payment provider: stripe"),
        ),
      ).toBe(true);
      expect(
        logged.some((line) =>
          line.includes(
            "[Payment] Resolving payment provider for existing payments: stripe",
          ),
        ),
      ).toBe(true);
    } finally {
      debug.restore();
      setSuppressDebugLogs(null);
    }
  });
});
