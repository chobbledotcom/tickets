// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { settings } from "#shared/db/settings.ts";
import {
  scenarioBrowser,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";

// jscpd:ignore-end

Given(
  "a Stripe test key is saved while Square takes payments",
  async function (this: TicketsWorld): Promise<void> {
    await settings.update.stripe.secretKey("sk_test_evidence");
    await settings.update.paymentProvider("square");
  },
);

When(
  "the organiser changes the payment provider to Stripe",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await submitRenderedAdminForm(
      this,
      "/admin/settings",
      "Save Payment Provider",
      { payment_provider: "stripe" },
    );
    expect(browser.currentUrl).toBe("/admin/settings");
  },
);

Then(
  "the payment settings show Stripe selected with its saved key in test mode",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(
      hasCheckedInput(browser.currentHtml, "payment_provider", "stripe"),
    ).toBe(true);
    expect(
      hasCheckedInput(browser.currentHtml, "payment_provider", "square"),
    ).toBe(false);
    for (const provider of ["Square", "Stripe", "SumUp"]) {
      expect(browser.pageText).toContain(provider);
    }
    expect(browser.pageText).toContain(
      "A Stripe secret key is currently configured",
    );
    expect(browser.pageText).toContain("Test mode:");
    expect(browser.pageText).toContain("No real charges will be made");
  },
);
