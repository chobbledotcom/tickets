import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getAllListings,
  invalidateListingsCache,
} from "#shared/db/listings.ts";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  adminGet,
  createTestListing,
  describeWithEnv,
  expectErrorFlash,
  expectFlash,
  testRequiresAuth,
} from "#test-utils";

const findByName = async (name: string) =>
  (await getAllListings()).find((l) => l.name === name);

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
        default_duration_days: "3",
      });
      const body = await adminGet("/admin/listing-defaults").then((r) =>
        r.text(),
      );
      // The duration input carries the saved value and Monday is pre-ticked.
      expect(body).toContain('value="3"');
      expect(body).toMatch(
        /value="Monday"[^>]*checked|checked[^>]*value="Monday"/,
      );
    });
  });

  describe("POST /admin/listing-defaults", () => {
    testRequiresAuth("/admin/listing-defaults", {
      body: { default_hidden: "1" },
      method: "POST",
    });

    test("saves the chosen defaults and round-trips them", async () => {
      const { response } = await adminFormPost("/admin/listing-defaults", {
        default_duration_days: "3",
        default_hidden: "1",
        default_webhook_url: "https://example.com/hook",
      });
      expect(response.status).toBe(302);
      expectFlash(response, expect.stringContaining("Listing defaults saved"));
      expect(settings.listingDefaults).toEqual({
        durationDays: 3,
        hidden: true,
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
      await adminFormPost("/admin/listing-defaults", {
        default_hidden: "1",
        default_webhook_url: "https://example.com/live",
      });
      invalidateListingsCache();
      const inheriting = await findByName("Inheriting listing");
      expect(inheriting?.hidden).toBe(true);
      expect(inheriting?.webhook_url).toBe("https://example.com/live");

      // Clear the defaults — it reverts to its own stored values.
      await adminFormPost("/admin/listing-defaults", {});
      invalidateListingsCache();
      const reverted = await findByName("Inheriting listing");
      expect(reverted?.hidden).toBe(false);
      expect(reverted?.webhook_url).toBe("");
    });

    test("a listing without Use-defaults keeps its own values", async () => {
      await adminFormPost("/admin/listing-defaults", { default_hidden: "1" });
      await createTestListing({
        hidden: false,
        name: "Own values listing",
        useDefaults: false,
      });
      invalidateListingsCache();
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
        default_customisable_days: "0",
        default_duration_days: "2",
        default_hidden: "1",
        default_maximum_days_after: "30",
        default_minimum_days_before: "1",
        default_thank_you_url: "https://example.com/thanks",
        default_uses_logistics: "1",
        default_webhook_url: "https://example.com/hook",
      });
      const response = await adminGet("/admin/listing/new?template=custom");
      const body = await response.text();
      expect(body).toContain('id="use-defaults"');
      expect(body).toContain("listing-form--default-hidden");
      expect(body).toContain("listing-form--default-webhook-url");
      // Defaulted fields are pre-filled with the default values.
      expect(body).toContain("https://example.com/hook");
      expect(body).toContain("https://example.com/thanks");
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
  });
});
