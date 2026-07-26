import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { PAYMENT_PROVIDER_IDS } from "#shared/payment-providers.ts";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { defaultSettingsState } from "./settings-state.ts";

describe("adminSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("omits the key-mode notice for a configured key with an unknown mode", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      paymentProvider: "sumup",
      sumupKeyConfigured: true,
      sumupKeyMode: null,
    });
    expect(html).toContain("A SumUp API key is currently configured");
    expect(html).not.toContain("Test mode");
    expect(html).not.toContain("Live mode");
  });

  test("renders the underline-links checkbox, unchecked by default", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain("Underline links");
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    expect(checkbox?.[0]).toContain('type="checkbox"');
    expect(checkbox?.[0]).not.toContain("checked");
  });

  test("checks the underline-links checkbox when enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      underlineLinks: true,
    });
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    expect(checkbox?.[0]).toContain("checked");
  });

  test("shows square webhook configured message when key is set", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      paymentProvider: "square",
      squareTokenConfigured: true,
      squareWebhookConfigured: true,
    });
    expect(html).toContain("A webhook signature key is currently configured");
    expect(html).toContain("Enter a new key below to replace it");
  });

  test("shows square webhook not configured message when key is not set", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      paymentProvider: "square",
      squareTokenConfigured: true,
    });
    expect(html).toContain("No webhook signature key is configured");
    expect(html).toContain("Follow the steps above to set one up");
  });

  test("shows sandbox checkbox checked when sandbox mode enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      paymentProvider: "square",
      squareSandbox: true,
      squareTokenConfigured: true,
    });
    const checkbox = html.match(/<input[^>]*name="square_sandbox"[^>]*>/);
    expect(checkbox?.[0]).toContain("checked");
  });

  test("shows settings sub-navigation", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain('href="/admin/settings-advanced"');
    expect(html).toContain('href="/admin/backup"');
    expect(html).toContain('href="/admin/debug"');
  });

  test("renders the calendar feeds form as markup, not escaped HTML", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain('action="/admin/settings/calendar-feeds"');
    expect(html).toContain('name="calendar_feeds_enabled"');
    expect(html).toContain('name="calendar_feeds_group_by"');
    expect(html).not.toContain("&lt;form");
  });

  test("checks the calendar feeds toggle when enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      calendarFeedsEnabled: true,
    });
    expect(hasCheckedInput(html, "calendar_feeds_enabled", "true")).toBe(true);
  });

  describe("PaymentProviderForm radio labels", () => {
    /** The visible label attached to one radio value, or null if absent. */
    const labelForValue = (html: string, value: string): string | null => {
      const match = html.match(
        new RegExp(
          `<input\\b[^>]*value="${value}"[^>]*>\\s*([^<]*?)\\s*</label>`,
        ),
      );
      return match?.[1] ?? null;
    };

    test("attaches each registry label to its own radio value", () => {
      const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
      expect(labelForValue(html, "stripe")).toBe("Stripe");
      expect(labelForValue(html, "square")).toBe("Square");
      expect(labelForValue(html, "sumup")).toBe("SumUp");
    });

    /** The `<input>` tag rendered for one radio value. */
    const inputForValue = (html: string, value: string): string =>
      html.match(new RegExp(`<input\\b[^>]*value="${value}"[^>]*>`))?.[0] ?? "";

    test("offers every provider when the site currency suits them all", () => {
      const html = adminSettingsPage(OWNER_SESSION, {
        ...defaultSettingsState(),
        currency: "GBP",
      });
      for (const id of PAYMENT_PROVIDER_IDS) {
        expect(inputForValue(html, id)).not.toContain("disabled");
      }
      expect(html).not.toContain("cannot take payments in");
    });

    test("switches off a provider that cannot take the site currency", () => {
      const html = adminSettingsPage(OWNER_SESSION, {
        ...defaultSettingsState(),
        currency: "JPY",
      });
      expect(inputForValue(html, "sumup")).toContain("disabled");
      expect(inputForValue(html, "stripe")).not.toContain("disabled");
      expect(inputForValue(html, "square")).not.toContain("disabled");
      expect(html).toContain(
        "SumUp cannot take payments in JPY. Choose a different payment provider.",
      );
    });

    test("checks exactly the radio matching the persisted provider", () => {
      const values = ["none", ...PAYMENT_PROVIDER_IDS];
      for (const selected of values) {
        const html = adminSettingsPage(OWNER_SESSION, {
          ...defaultSettingsState(),
          paymentProvider: selected === "none" ? "" : selected,
        });
        for (const value of values) {
          expect(hasCheckedInput(html, "payment_provider", value)).toBe(
            value === selected,
          );
        }
      }
    });
  });
});
