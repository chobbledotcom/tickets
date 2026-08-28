// jscpd:ignore-start

import { Given, Then, When } from "@cucumber/cucumber";
import { expect } from "@std/expect";
import { settings } from "#db/settings.ts";
import { bunnyCdnApi } from "#shared/bunny-cdn.ts";
import {
  openAdminPage,
  scenarioBrowser,
  submitRenderedAdminForm,
} from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
import { withEnv } from "#test-utils/env.ts";
import { withMockBunnyCdnApi } from "#test-utils/mocks.ts";
import { requirePaymentProviderRecovery } from "#test-utils/settings.ts";

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
    expect(browser.pageText).toContain("Your Stripe credentials are saved");
    expect(browser.pageText).toContain("Test mode:");
    expect(browser.pageText).toContain("No real charges will be made");
  },
);

const submitButton = (html: string, label: string): string => {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([markup]) => markup)
    .find((markup) => markup.includes(`<span>${label}</span>`));
  if (!button) throw new Error(`The page has no "${label}" button`);
  return button;
};

const expectButtonDisabled = (
  html: string,
  label: string,
  disabled: boolean,
): void => {
  expect(submitButton(html, label).includes(" disabled")).toBe(disabled);
};

const setUpProviderRecovery = (): Promise<void> =>
  requirePaymentProviderRecovery();

Given(
  "Stripe and Square were configured before new sales were turned off",
  async function (this: TicketsWorld): Promise<void> {
    await setUpProviderRecovery();
  },
);

Given(
  "provider recovery is needed and both domain options are available",
  async function (this: TicketsWorld): Promise<void> {
    await setUpProviderRecovery();
    const env = withEnv({
      BUNNY_API_KEY: "bunny-key",
      BUNNY_DNS_SUBDOMAIN_SUFFIX: ".tickets",
      BUNNY_DNS_ZONE_ID: "42",
      BUNNY_SCRIPT_ID: "script-id",
    });
    const original = bunnyCdnApi.getCdnHostname;
    bunnyCdnApi.getCdnHostname = () =>
      Promise.resolve({ hostname: "site.b-cdn.net", ok: true as const });
    this.cleanup.add(
      () => {
        bunnyCdnApi.getCdnHostname = original;
      },
      () => env.dispose(),
    );
  },
);

When(
  "the organiser opens the payment settings",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, "/admin/settings");
  },
);

When(
  "the organiser opens the domain settings",
  async function (this: TicketsWorld): Promise<void> {
    await openAdminPage(this, "/admin/settings-advanced");
  },
);

When(
  "the organiser chooses Stripe for existing payments",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await submitRenderedAdminForm(
      this,
      "/admin/settings",
      "Save existing payment provider",
      { existing_payment_provider: "stripe" },
    );
    expect(browser.currentUrl).toBe("/admin/settings");
  },
);

When(
  "the organiser checks whether the host subdomain {string} is available",
  async function (this: TicketsWorld, subdomain: string): Promise<void> {
    await withMockBunnyCdnApi(
      {
        checkSubdomainAvailable: () =>
          Promise.resolve({
            available: true,
            fullDomain: `${subdomain}.tickets`,
            ok: true as const,
          }),
      },
      async () => {
        await submitRenderedAdminForm(
          this,
          "/admin/settings-advanced",
          "Check Availability &amp; Preview Complete Domain",
          { subdomain },
        );
      },
    );
  },
);

When(
  "the organiser registers the host subdomain {string}",
  async function (this: TicketsWorld, subdomain: string): Promise<void> {
    await withMockBunnyCdnApi(
      {
        registerBunnySubdomain: () =>
          Promise.resolve({
            fullDomain: `${subdomain}.tickets`,
            ok: true as const,
          }),
      },
      async () => {
        const browser = scenarioBrowser(this);
        await fillInAndSend(
          browser,
          { save: "1", subdomain },
          "Register Subdomain",
        );
        expect(browser.currentUrl).toBe("/admin");
      },
    );
  },
);

Then(
  "the organiser must choose the provider for existing payments",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(browser.pageText).toContain("Provider for existing payments");
    expect(browser.pageText).toContain("New sales will stay off.");
    expect(browser.currentHtml).toContain(
      'id="settings-payment-provider-recovery"',
    );
    for (const provider of ["stripe", "square"]) {
      const input = inputTagWithValue(
        browser.currentHtml,
        provider,
        "existing_payment_provider",
      );
      expect(input).toContain('name="existing_payment_provider"');
      expect(input).toContain("required");
      expect(input).toContain(`value="${provider}"`);
    }
  },
);

Then(
  "new sales stay off and the saved Stripe settings remain available",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expect(
      hasCheckedInput(browser.currentHtml, "payment_provider", "none"),
    ).toBe(true);
    expect(browser.currentHtml).not.toContain(
      'id="settings-payment-provider-recovery"',
    );
    expect(browser.currentHtml).toContain('id="settings-stripe"');
  },
);

Then(
  "custom domain changes are unavailable until a provider is chosen",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expectButtonDisabled(browser.currentHtml, "Save Custom Domain", true);
    expect(browser.pageText).toContain(
      "Choose the provider for existing payments before changing your domain.",
    );
  },
);

Then(
  "custom domain changes are available again",
  async function (this: TicketsWorld): Promise<void> {
    const browser = await openAdminPage(this, "/admin/settings-advanced");
    expectButtonDisabled(browser.currentHtml, "Save Custom Domain", false);
    expect(browser.pageText).not.toContain(
      "Choose the provider for existing payments before changing your domain.",
    );
  },
);

Then(
  "host subdomain registration is unavailable until a provider is chosen",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expectButtonDisabled(browser.currentHtml, "Register Subdomain", true);
    expect(browser.pageText).toContain(
      "Choose the provider for existing payments before changing your domain.",
    );
  },
);

Then(
  "host subdomain registration is available again",
  function (this: TicketsWorld): void {
    const browser = scenarioBrowser(this);
    expectButtonDisabled(browser.currentHtml, "Register Subdomain", false);
    expect(browser.pageText).not.toContain(
      "Choose the provider for existing payments before changing your domain.",
    );
  },
);

Then(
  "the host subdomain {string} is registered",
  function (this: TicketsWorld, domain: string): void {
    expect(settings.bunnySubdomain).toBe(domain);
  },
);
