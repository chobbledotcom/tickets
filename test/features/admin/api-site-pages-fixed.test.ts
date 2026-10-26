// Contract tests for the fixed pages (home, contact and terms) on the
// site-pages admin JSON API: read by name, content updated through the
// settings writers, and the refusals (no create, delete, or hidden flag).
// The content-page CRUD lives in api-site-pages.test.ts, the input mapping's
// field refusals in api-site-pages-input.test.ts, and the form-side parity
// pins in test/features/admin/parity/site-pages.test.ts.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import { wasActivityLogged } from "#test-utils/activity-log.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { apiRequest } from "#test-utils/session.ts";
import { settingsAsStored } from "#test-utils/settings.ts";

describeWithEnv("Admin API - Site pages fixed", { db: true }, () => {
  describe("the fixed pages (home, contact, terms)", () => {
    test("reads the home page content the settings store", async () => {
      await settings.update.homepageText("Welcome to the hut.");
      await assertJson(
        apiRequest("/api/admin/site-pages/home"),
        200,
        (body) => {
          expect(body.page).toEqual({
            content: "Welcome to the hut.",
            name: "home",
          });
        },
      );
    });

    test("reads the contact page content the settings store", async () => {
      await settings.update.contactPageText("Write to us.");
      await assertJson(
        apiRequest("/api/admin/site-pages/contact"),
        200,
        (body) => {
          expect(body.page).toEqual({
            content: "Write to us.",
            name: "contact",
          });
        },
      );
    });

    test("reads the terms page content the settings store", async () => {
      await settings.update.terms("No refunds after booking.");
      await assertJson(
        apiRequest("/api/admin/site-pages/terms"),
        200,
        (body) => {
          expect(body.page).toEqual({
            content: "No refunds after booking.",
            name: "terms",
          });
        },
      );
    });

    test("updates the home page content through the settings writer", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "New home text" },
          method: "PUT",
        }),
        200,
        (body) => {
          expect(body.page).toEqual({ content: "New home text", name: "home" });
        },
      );
      await settingsAsStored();
      expect(settings.homepageText).toBe("New home text");
      expect(await wasActivityLogged("Page 'home' updated")).toBe(true);
    });

    test("updates the contact page content", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/contact", {
          body: { content: "Email us." },
          method: "PUT",
        }),
        200,
      );
      await settingsAsStored();
      expect(settings.contactPageText).toBe("Email us.");
    });

    test("updates the terms page content", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/terms", {
          body: { content: "Agree to the rules." },
          method: "PUT",
        }),
        200,
      );
      await settingsAsStored();
      expect(settings.terms).toBe("Agree to the rules.");
    });

    test("keeps the stored content when the update body is silent", async () => {
      await settings.update.homepageText("Existing text");
      await assertJson(
        apiRequest("/api/admin/site-pages/home", { body: {}, method: "PUT" }),
        200,
        (body) => {
          expect(body.page).toEqual({ content: "Existing text", name: "home" });
        },
      );
      await settingsAsStored();
      expect(settings.homepageText).toBe("Existing text");
    });

    test("refuses to create a fixed page", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "A new home" },
          method: "POST",
        }),
        400,
        (body) => {
          expect(body.error).toBe("fixed pages cannot be created");
        },
      );
    });

    test("refuses to delete a fixed page", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { confirm_identifier: "home" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(body.error).toBe("fixed pages cannot be deleted");
        },
      );
    });

    test("refuses to hide a fixed page", async () => {
      await settings.update.homepageText("Existing");
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "New", hidden: true },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("hidden cannot change on a fixed page");
        },
      );
      await settingsAsStored();
      expect(settings.homepageText).toBe("Existing");
    });

    test("refuses a fixed-page field the page does not carry", async () => {
      await settings.update.homepageText("Existing");
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: "New", name: "Renamed" },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("name cannot change on a fixed page");
        },
      );
      await settingsAsStored();
      expect(settings.homepageText).toBe("Existing");
    });

    test("refuses a non-string content value with the field message", async () => {
      await assertJson(
        apiRequest("/api/admin/site-pages/home", {
          body: { content: 5 },
          method: "PUT",
        }),
        400,
        (body) => {
          expect(body.error).toBe("content must be a string");
        },
      );
    });

    test("refuses fixed-page content past the textarea cap", async () => {
      await settings.update.homepageText("Existing");
      const response = await apiRequest("/api/admin/site-pages/home", {
        body: { content: "x".repeat(MAX_TEXTAREA_LENGTH + 1) },
        method: "PUT",
      });
      expect(response.status).toBe(400);
      await settingsAsStored();
      expect(settings.homepageText).toBe("Existing");
    });
  });
});
