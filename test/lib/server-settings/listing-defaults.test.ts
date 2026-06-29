import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAllListings } from "#shared/db/listings.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  adminFormPost,
  adminGet,
  createTestListing,
  describeWithEnv,
  expectErrorFlash,
  expectFlash,
  testRequiresAuth,
} from "#test-utils";
import { extractFormEntries } from "#test-utils/test-browser.ts";

const findByName = async (name: string) =>
  (await getAllListings()).find((l) => l.name === name);

/** The defaults form's submittable controls, grouped by input name — what a
 * browser would POST, so it reflects which option is selected and which boxes
 * are ticked. */
const submittedDefaults = async (): Promise<Map<string, string[]>> => {
  const body = await (await adminGet("/admin/listing-defaults")).text();
  const grouped = new Map<string, string[]>();
  for (const [name, value] of extractFormEntries(body)) {
    grouped.set(name, [...(grouped.get(name) ?? []), value]);
  }
  return grouped;
};

describeWithEnv("server (admin listing defaults)", { db: true }, () => {
  describe("GET /admin/listing-defaults", () => {
    testRequiresAuth("/admin/listing-defaults");

    test("renders the defaults form", async () => {
      const response = await adminGet("/admin/listing-defaults");
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain('name="default_hidden"');
      expect(body).toContain('name="default_webhook_url"');
    });

    test("pre-fills the form with the saved number and day defaults", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_bookable_days: "Monday",
        default_bookable_days_enabled: "1",
        default_minimum_days_before: "3",
      });
      const response = await adminGet("/admin/listing-defaults");
      const body = await response.text();
      // The number input carries the saved value and Monday is pre-ticked.
      expect(body).toContain('value="3"');
      expect(body).toMatch(
        /value="Monday"[^>]*checked|checked[^>]*value="Monday"/,
      );
    });

    test("a true bool default selects the Yes option", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "1" });
      expect((await submittedDefaults()).get("default_hidden")).toEqual(["1"]);
    });

    test("a false bool default selects the No option", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "0" });
      expect((await submittedDefaults()).get("default_hidden")).toEqual(["0"]);
    });

    test("an unset bool default selects No default", async () => {
      // Save an unrelated default so the page still renders its controls.
      await adminFormPost("/admin/listing-defaults", {
        default_minimum_days_before: "3",
      });
      expect((await submittedDefaults()).get("default_hidden")).toEqual([""]);
    });

    test("a days default ticks its enable box and only the chosen days", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_bookable_days: "Monday",
        default_bookable_days_enabled: "1",
      });
      const submitted = await submittedDefaults();
      expect(submitted.get("default_bookable_days_enabled")).toEqual(["1"]);
      expect(submitted.get("default_bookable_days")).toEqual(["Monday"]);
    });

    test("no days default leaves the enable box and every day unticked", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_minimum_days_before: "3",
      });
      const submitted = await submittedDefaults();
      expect(submitted.get("default_bookable_days_enabled")).toBeUndefined();
      expect(submitted.get("default_bookable_days")).toBeUndefined();
    });

    test("a url default pre-fills its input", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_webhook_url: "https://example.com/hook",
      });
      expect((await submittedDefaults()).get("default_webhook_url")).toEqual([
        "https://example.com/hook",
      ]);
    });
  });

  describe("POST /admin/listing-defaults", () => {
    testRequiresAuth("/admin/listing-defaults", {
      body: { default_hidden: "1" },
      method: "POST",
    });

    test("saves the chosen defaults and round-trips them", async () => {
      const { response } = await adminFormPost("/admin/listing-defaults", {
        default_hidden: "1",
        default_minimum_days_before: "3",
        default_webhook_url: "https://example.com/hook",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Listing defaults saved"));
      expect(settings.listingDefaults).toEqual({
        hidden: true,
        minimumDaysBefore: 3,
        webhookUrl: "https://example.com/hook",
      });
    });

    test("an empty submission clears every default", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "1" });
      await adminFormPost("/admin/listing-defaults", {});
      expect(settings.listingDefaults).toEqual({});
    });

    test("rejects an invalid webhook url without saving", async () => {
      const { response } = await adminFormPost("/admin/listing-defaults", {
        default_webhook_url: "not-a-url",
      });
      expectErrorFlash(response, "https");
      expect(settings.listingDefaults).toEqual({});
    });

    test("ignores the logistics default while logistics is disabled", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_uses_logistics: "1",
      });
      expect("usesLogistics" in settings.listingDefaults).toBe(false);
    });

    test("accepts the logistics default once logistics is enabled", async () => {
      await settings.update.hasLogistics(true);
      await adminFormPost("/admin/listing-defaults", {
        default_uses_logistics: "1",
      });
      expect(settings.listingDefaults.usesLogistics).toBe(true);
    });

    test("disabling logistics clears the saved logistics default", async () => {
      await settings.update.hasLogistics(true);
      await adminFormPost("/admin/listing-defaults", {
        default_hidden: "1",
        default_uses_logistics: "1",
      });
      expect(settings.listingDefaults.usesLogistics).toBe(true);

      // Turning the feature off removes the logistics default (but keeps others),
      // so re-enabling later can't resurrect it onto Use-defaults listings.
      await adminFormPost("/admin/logistics/has-logistics", {
        has_logistics: "false",
      });
      expect("usesLogistics" in settings.listingDefaults).toBe(false);
      expect(settings.listingDefaults.hidden).toBe(true);
    });

    test("stores the defaults blob encrypted at rest", async () => {
      await adminFormPost("/admin/listing-defaults", {
        default_thank_you_url: "https://secret.example.com/token-abc",
        default_webhook_url: "https://secret.example.com/hook-xyz",
      });
      // Round-trips through decryption…
      expect(settings.listingDefaults.webhookUrl).toBe(
        "https://secret.example.com/hook-xyz",
      );
      // …but the stored value is ciphertext, not the plaintext URL.
      const stored = settings.getCachedRaw(CONFIG_KEYS.LISTING_DEFAULTS) ?? "";
      expect(stored).not.toContain("secret.example.com");
      expect(stored).not.toContain("hook-xyz");
    });

    test("refuses a webhook default in demo mode", async () => {
      setDemoModeForTest(true);
      await adminFormPost("/admin/listing-defaults", {
        default_hidden: "1",
        default_webhook_url: "https://example.com/hook",
      });
      expect(settings.listingDefaults.hidden).toBe(true);
      expect("webhookUrl" in settings.listingDefaults).toBe(false);
    });
  });

  describe("live inheritance", () => {
    test("a Use-defaults listing follows the current defaults, then reverts", async () => {
      const listing = await createTestListing({
        hidden: false,
        name: "Inheriting listing",
        useDefaults: true,
        webhookUrl: "",
      });
      expect(listing.use_defaults).toBe(true);

      // Set a default after the listing exists — it should inherit live.
      // Saving defaults must invalidate the listings cache itself (no manual
      // invalidation here), or warm isolates would keep serving stale values.
      await adminFormPost("/admin/listing-defaults", {
        default_hidden: "1",
        default_webhook_url: "https://example.com/live",
      });
      const inheriting = await findByName("Inheriting listing");
      expect(inheriting?.hidden).toBe(true);
      expect(inheriting?.webhook_url).toBe("https://example.com/live");

      // Clear the defaults — it reverts to its own stored values.
      await adminFormPost("/admin/listing-defaults", {});
      const reverted = await findByName("Inheriting listing");
      expect(reverted?.hidden).toBe(false);
      expect(reverted?.webhook_url).toBe("");
    });

    test("disabling logistics drops an inherited logistics value live", async () => {
      await settings.update.hasLogistics(true);
      await adminFormPost("/admin/listing-defaults", {
        default_uses_logistics: "1",
      });
      await createTestListing({
        name: "Logistics inheritor",
        useDefaults: true,
      });
      // Materialise it into the listings cache while the default applies.
      expect((await findByName("Logistics inheritor"))?.uses_logistics).toBe(
        true,
      );

      // Disabling logistics clears the default and must invalidate the listings
      // cache itself, or the warm row keeps reading as a logistics listing.
      await adminFormPost("/admin/logistics/has-logistics", {
        has_logistics: "false",
      });
      expect((await findByName("Logistics inheritor"))?.uses_logistics).toBe(
        false,
      );
    });

    test("a listing without Use-defaults keeps its own values", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "1" });
      await createTestListing({
        hidden: false,
        name: "Own values listing",
        useDefaults: false,
      });
      const own = await findByName("Own values listing");
      expect(own?.hidden).toBe(false);
    });
  });

  describe("listing form integration", () => {
    test("new listing form shows the toggle and hides defaulted fields", async () => {
      await settings.update.hasLogistics(true);
      // Set every default so the create form pre-fills each defaulted field.
      await adminFormPost("/admin/listing-defaults", {
        default_bookable_days: "Monday",
        default_bookable_days_enabled: "1",
        default_hidden: "1",
        default_maximum_days_after: "30",
        default_minimum_days_before: "1",
        default_thank_you_url: "https://example.com/thanks",
        // A "no" bool default exercises the unchecked checkbox pre-fill.
        default_uses_logistics: "0",
        default_webhook_url: "https://example.com/hook",
      });
      const response = await adminGet("/admin/listing/new?template=custom");
      const body = await response.text();
      expect(body).toContain('id="use-defaults"');
      // A plain (Custom) new listing starts with Use-defaults checked.
      expect(body).toMatch(/checked[^>]*id="use-defaults"/);
      expect(body).toContain("listing-form--default-hidden");
      expect(body).toContain("listing-form--default-webhook-url");
      // Defaulted fields are pre-filled with the default values.
      expect(body).toContain("https://example.com/hook");
      expect(body).toContain("https://example.com/thanks");
    });

    test("a template-picked new listing keeps Use-defaults off so the template wins", async () => {
      await settings.update.hasLogistics(true);
      // A logistics=no default would otherwise un-logistic the Hireable card.
      await adminFormPost("/admin/listing-defaults", {
        default_uses_logistics: "0",
      });
      const response = await adminGet(
        "/admin/listing/new?template=hireable-item",
      );
      const body = await response.text();
      // The toggle is shown but NOT pre-checked, so the template's pinned
      // logistics dimension is not overridden by the conflicting default.
      expect(body).toContain('id="use-defaults"');
      expect(body).not.toMatch(/checked[^>]*id="use-defaults"/);
    });

    test("edit form reflects a listing's Use-defaults flag", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "1" });
      const listing = await createTestListing({
        name: "Editable",
        useDefaults: true,
      });
      const response = await adminGet(`/admin/listing/${listing.id}/edit`);
      const body = await response.text();
      expect(body).toContain('id="use-defaults"');
    });

    test("no toggle when the operator has set no defaults", async () => {
      const response = await adminGet("/admin/listing/new?template=custom");
      const body = await response.text();
      expect(body).not.toContain('id="use-defaults"');
    });

    test("preserves an inheriting listing's flag while no defaults exist", async () => {
      // Listing flagged to inherit, but the operator has since cleared every
      // default — the edit form has no visible toggle, so it must carry the
      // flag in a hidden input rather than silently dropping it on save.
      const listing = await createTestListing({
        name: "Still inheriting",
        useDefaults: true,
      });
      const response = await adminGet(`/admin/listing/${listing.id}/edit`);
      const body = await response.text();
      expect(body).not.toContain('id="use-defaults"');
      expect(body).toContain('name="use_defaults" type="hidden" value="1"');
    });
  });
});
