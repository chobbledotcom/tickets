import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllListings,
  getStoredListingWithCount,
} from "#db/listings/records.ts";
import { CONFIG_KEYS, settings } from "#db/settings.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  expectFlash,
  expectIncludesAll,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildUpdateListingForm } from "#test-utils/db-helpers/listing-forms.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminFormPost,
  adminGet,
  adminMultipartPost,
  setupListingAndLogin,
} from "#test-utils/session.ts";
import { enableFeature } from "#test-utils/settings.ts";
import { expectFormValueRefused } from "#test-utils/settings-refusal.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";

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
      expectIncludesAll(body, [
        'name="defaultHidden"',
        'name="defaultWebhookUrl"',
      ]);
    });

    test("pre-fills the form with the saved number and day defaults", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultBookableDays: "Monday",
        defaultBookableDaysEnabled: "1",
        defaultMinimumDaysBefore: "3",
      });
      const response = await adminGet("/admin/listing-defaults");
      const body = await response.text();
      // The number input carries the saved value and Monday is pre-ticked.
      assertStringIncludes(body, 'value="3"');
      expect(body).toMatch(
        /value="Monday"[^>]*checked|checked[^>]*value="Monday"/,
      );
    });

    test("a true bool default selects the Yes option", async () => {
      await adminFormPost("/admin/listing-defaults", { defaultHidden: "1" });
      expect((await submittedDefaults()).get("defaultHidden")).toEqual(["1"]);
    });

    test("a false bool default selects the No option", async () => {
      await adminFormPost("/admin/listing-defaults", { defaultHidden: "0" });
      expect((await submittedDefaults()).get("defaultHidden")).toEqual(["0"]);
    });

    test("an unset bool default selects No default", async () => {
      // Save an unrelated default so the page still renders its controls.
      await adminFormPost("/admin/listing-defaults", {
        defaultMinimumDaysBefore: "3",
      });
      expect((await submittedDefaults()).get("defaultHidden")).toEqual([""]);
    });

    test("a days default ticks its enable box and only the chosen days", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultBookableDays: "Monday",
        defaultBookableDaysEnabled: "1",
      });
      const submitted = await submittedDefaults();
      expect(submitted.get("defaultBookableDaysEnabled")).toEqual(["1"]);
      expect(submitted.get("defaultBookableDays")).toEqual(["Monday"]);
    });

    test("no days default leaves the enable box and every day unticked", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultMinimumDaysBefore: "3",
      });
      const submitted = await submittedDefaults();
      expect(submitted.get("defaultBookableDaysEnabled")).toBe(undefined);
      expect(submitted.get("defaultBookableDays")).toBe(undefined);
    });

    test("a url default pre-fills its input", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultWebhookUrl: "https://example.com/hook",
      });
      expect((await submittedDefaults()).get("defaultWebhookUrl")).toEqual([
        "https://example.com/hook",
      ]);
    });
  });

  describe("POST /admin/listing-defaults", () => {
    testRequiresAuth("/admin/listing-defaults", {
      body: { defaultHidden: "1" },
      method: "POST",
    });

    test("saves the chosen defaults and round-trips them", async () => {
      const { response } = await adminFormPost("/admin/listing-defaults", {
        defaultHidden: "1",
        defaultMinimumDaysBefore: "3",
        defaultWebhookUrl: "https://example.com/hook",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toMatch(
        /^\/admin\/listing-defaults\?flash=/,
      );
      expectFlash(response, expect.stringContaining("Listing defaults saved"));
      expect(settings.listingDefaults).toEqual({
        hidden: true,
        minimumDaysBefore: 3,
        webhookUrl: "https://example.com/hook",
      });
    });

    test("an empty submission clears every default", async () => {
      await adminFormPost("/admin/listing-defaults", { defaultHidden: "1" });
      await adminFormPost("/admin/listing-defaults", {});
      expect(settings.listingDefaults).toEqual({});
    });

    test("rejects an invalid webhook url without saving", async () => {
      await expectFormValueRefused(
        {
          fields: { defaultWebhookUrl: "not-a-url" },
          flash: "https",
          path: "/admin/listing-defaults",
          stored: () => settings.listingDefaults,
        },
        {},
      );
    });

    test("ignores the logistics default while logistics is disabled", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultUsesLogistics: "1",
      });
      expect("usesLogistics" in settings.listingDefaults).toBe(false);
    });

    test("accepts the logistics default once logistics is enabled", async () => {
      await enableFeature("logistics");
      await adminFormPost("/admin/listing-defaults", {
        defaultUsesLogistics: "1",
      });
      expect(settings.listingDefaults.usesLogistics).toBe(true);
    });

    test("disabling logistics clears the saved logistics default", async () => {
      await enableFeature("logistics");
      await adminFormPost("/admin/listing-defaults", {
        defaultHidden: "1",
        defaultUsesLogistics: "1",
      });
      expect(settings.listingDefaults.usesLogistics).toBe(true);

      // Turning the feature off removes the logistics default (but keeps others),
      // so re-enabling later can't resurrect it onto Use-defaults listings.
      await adminFormPost("/admin/features/logistics", {
        enabled: "false",
      });
      expect("usesLogistics" in settings.listingDefaults).toBe(false);
      expect(settings.listingDefaults.hidden).toBe(true);
    });

    test("stores the defaults blob encrypted at rest", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultThankYouUrl: "https://secret.example.com/token-abc",
        defaultWebhookUrl: "https://secret.example.com/hook-xyz",
      });
      // Round-trips through decryption…
      expect(settings.listingDefaults.webhookUrl).toBe(
        "https://secret.example.com/hook-xyz",
      );
      // …but the stored value is ciphertext, not the plaintext URL.
      const stored = settings.getCachedRaw(CONFIG_KEYS.LISTING_DEFAULTS) ?? "";
      assert(!stored.includes("secret.example.com"));
      assert(!stored.includes("hook-xyz"));
    });

    test("refuses a webhook default in demo mode but keeps the thank-you url", async () => {
      setDemoModeForTest(true);
      await adminFormPost("/admin/listing-defaults", {
        defaultHidden: "1",
        defaultThankYouUrl: "https://example.com/thanks",
        defaultWebhookUrl: "https://example.com/hook",
      });
      expect(settings.listingDefaults.hidden).toBe(true);
      // Only the outbound webhook is blocked in demo mode — the thank-you
      // redirect (no PII callback) still saves.
      expect("webhookUrl" in settings.listingDefaults).toBe(false);
      expect(settings.listingDefaults.thankYouUrl).toBe(
        "https://example.com/thanks",
      );
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
      expect(listing.useDefaults).toBe(true);

      // Set a default after the listing exists — it should inherit live.
      // Saving defaults must invalidate the listings cache itself (no manual
      // invalidation here), or warm isolates would keep serving stale values.
      await adminFormPost("/admin/listing-defaults", {
        defaultHidden: "1",
        defaultWebhookUrl: "https://example.com/live",
      });
      const inheriting = await findByName("Inheriting listing");
      expect(inheriting?.hidden).toBe(true);
      expect(inheriting?.webhookUrl).toBe("https://example.com/live");

      // Clear the defaults — it reverts to its own stored values.
      await adminFormPost("/admin/listing-defaults", {});
      const reverted = await findByName("Inheriting listing");
      expect(reverted?.hidden).toBe(false);
      expect(reverted?.webhookUrl).toBe("");
    });

    test("disabling logistics drops an inherited logistics value live", async () => {
      await enableFeature("logistics");
      await adminFormPost("/admin/listing-defaults", {
        defaultUsesLogistics: "1",
      });
      await createTestListing({
        name: "Logistics inheritor",
        useDefaults: true,
      });
      // Materialise it into the listings cache while the default applies.
      expect((await findByName("Logistics inheritor"))?.usesLogistics).toBe(
        true,
      );

      // Disabling logistics clears the default and must invalidate the listings
      // cache itself, or the warm row keeps reading as a logistics listing.
      await adminFormPost("/admin/features/logistics", {
        enabled: "false",
      });
      expect((await findByName("Logistics inheritor"))?.usesLogistics).toBe(
        false,
      );
    });

    test("a listing without Use-defaults keeps its own values", async () => {
      await adminFormPost("/admin/listing-defaults", { defaultHidden: "1" });
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
      await enableFeature("logistics");
      // Set every default so the create form pre-fills each defaulted field.
      await adminFormPost("/admin/listing-defaults", {
        defaultBookableDays: "Monday",
        defaultBookableDaysEnabled: "1",
        defaultHidden: "1",
        defaultMaximumDaysAfter: "30",
        defaultMinimumDaysBefore: "1",
        defaultThankYouUrl: "https://example.com/thanks",
        // A "no" bool default exercises the unchecked checkbox pre-fill.
        defaultUsesLogistics: "0",
        defaultWebhookUrl: "https://example.com/hook",
      });
      const response = await adminGet("/admin/listing/new?template=custom");
      const body = await response.text();
      assertStringIncludes(body, 'id="use-defaults"');
      // A plain (Custom) new listing starts with Use-defaults checked.
      expect(body).toMatch(/checked[^>]*id="use-defaults"/);
      expectIncludesAll(body, [
        "listing-form--default-hidden",
        "listing-form--default-webhook-url",
        // Defaulted fields are pre-filled with the default values.
        "https://example.com/hook",
        "https://example.com/thanks",
      ]);
    });

    test("a template-picked new listing keeps Use-defaults off so the template wins", async () => {
      await enableFeature("logistics");
      // A logistics=no default would otherwise un-logistic the Hireable card.
      await adminFormPost("/admin/listing-defaults", {
        defaultUsesLogistics: "0",
      });
      const response = await adminGet(
        "/admin/listing/new?template=hireable-item",
      );
      const body = await response.text();
      // The toggle is shown but NOT pre-checked, so the template's pinned
      // logistics dimension is not overridden by the conflicting default.
      assertStringIncludes(body, 'id="use-defaults"');
      expect(body).not.toMatch(/checked[^>]*id="use-defaults"/);
    });

    test("edit form pre-fills a listing's own stored values, not the inherited defaults", async () => {
      await adminFormPost("/admin/listing-defaults", {
        defaultHidden: "1",
        defaultWebhookUrl: "https://default.example/hook",
      });
      const listing = await createTestListing({
        hidden: false,
        name: "Own data",
        useDefaults: true,
        webhookUrl: "https://own.example/hook",
      });
      const body = await (
        await adminGet(`/admin/listing/${listing.id}/edit`)
      ).text();
      const submitted = new Map<string, string[]>();
      for (const [name, value] of extractFormEntries(body)) {
        submitted.set(name, [...(submitted.get(name) ?? []), value]);
      }
      // The webhook field carries the listing's OWN url (so a normal save
      // preserves it), not the inherited default…
      expect(submitted.get("webhookUrl")).toEqual([
        "https://own.example/hook",
      ]);
      // …and the hidden checkbox reflects the stored false (unchecked, so not
      // submitted), not the inherited Hidden=Yes default.
      expect(submitted.get("hidden")).toBe(undefined);
    });

    test("edit form reflects a listing's Use-defaults flag", async () => {
      await adminFormPost("/admin/listing-defaults", { defaultHidden: "1" });
      const inheriting = await createTestListing({
        name: "Inheriting",
        useDefaults: true,
      });
      const ownValues = await createTestListing({
        name: "Own values",
        useDefaults: false,
      });

      const onBody = await (
        await adminGet(`/admin/listing/${inheriting.id}/edit`)
      ).text();
      // An inheriting listing renders the toggle pre-checked…
      expect(onBody).toMatch(/checked[^>]*id="use-defaults"/);

      const offBody = await (
        await adminGet(`/admin/listing/${ownValues.id}/edit`)
      ).text();
      // …and a non-inheriting one renders it present but unchecked.
      assertStringIncludes(offBody, 'id="use-defaults"');
      expect(offBody).not.toMatch(/checked[^>]*id="use-defaults"/);
    });

    test("with no defaults set, no form shows the toggle and a save keeps an inheriting listing's flag", async () => {
      // The listing was flagged to inherit, but the operator has since cleared
      // every default. The edit form shows no toggle and sends no flag, so the
      // save keeps the stored one.
      const { listing } = await setupListingAndLogin({
        name: "Still inheriting",
        useDefaults: true,
      });
      const pages = await Promise.all(
        [
          "/admin/listing/new?template=custom",
          `/admin/listing/${listing.id}/edit`,
        ].map(async (path) => (await adminGet(path)).text()),
      );
      // The owner's query log names the column, so match the toggle markup.
      expect(
        pages.filter((page) =>
          /id="use-defaults"|name="useDefaults"/.test(page),
        ),
      ).toEqual([]);
      const { response: saved } = await adminMultipartPost(
        `/admin/listing/${listing.id}/edit`,
        buildUpdateListingForm(
          { name: "Renamed" },
          (await getStoredListingWithCount(listing.id))!,
        ),
      );
      expect([
        saved.status,
        (await getStoredListingWithCount(listing.id))!.useDefaults,
      ]).toEqual([302, true]);
    });
  });
});
