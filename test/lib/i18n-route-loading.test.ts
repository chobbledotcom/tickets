// test-groups: run-alone - grouped route imports can mask the cold module
// evaluation this suite verifies.
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withColdMessages } from "#test-utils/i18n.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";
import { enablePublicApi, enablePublicSite } from "#test-utils/settings.ts";

describeWithEnv("route message loading", { db: true }, () => {
  test("a static response leaves feature messages unloaded", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/robots.txt"));

      expect(response.status).toBe(200);
      expect(() => t("common.yes")).toThrow(
        'Missing translation for key "common.yes"',
      );
    }));

  test("a disabled public page rejects before loading public copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/"));

      expect(response.status).toBe(302);
      expect(() => t("common.yes")).toThrow(
        'Missing translation for key "common.yes"',
      );
    }));

  test("disabled news rejects before loading news copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/news"));

      expect(response.status).toBe(302);
      expect(() => t("news.title")).toThrow(
        'Missing translation for key "news.title"',
      );
    }));

  test("a disabled content page rejects before loading page copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/page/example"));

      expect(response.status).toBe(302);
      expect(() => t("site.pages.title")).toThrow(
        'Missing translation for key "site.pages.title"',
      );
    }));

  test("an enabled public page loads public copy but not admin copy", () =>
    withColdMessages(async () => {
      await enablePublicSite();
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/"));

      expect(response.status).toBe(200);
      expect(t("common.yes")).toBe("Yes");
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    }));

  test("a ticket page loads QR copy", async () => {
    const listing = await createTestListing();
    const { token } = await createTestAttendeeDirect(
      listing.id,
      "Cold Ticket",
      "cold-ticket@test.com",
    );

    await withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest(`/t/${token}`));

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('alt="QR code"');
    });
  });

  test("an inherited admin segment leaves admin copy unloaded", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/admin/constructor"));

      expect(response.status).toBe(404);
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    }));

  test("an unsigned admin request rejects before loading admin copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/admin/listings"));

      expect(response.status).toBe(302);
      expect(() => t("admin.footer.sql_queries")).toThrow(
        'Missing translation for key "admin.footer.sql_queries"',
      );
    }));

  test("the setup route loads setup copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/setup"));

      expect(response.status).toBe(302);
      expect(t("setup.title")).toBe("Setup");
    }));

  test("the scheduled route leaves builder copy unloaded", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(
        mockRequest("/scheduled", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      expect(() => t("builder.site_builder_title")).toThrow(
        'Missing translation for key "builder.site_builder_title"',
      );
    }));

  test("the admin API rejects before loading resource copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/api/admin/groups"));

      expect(response.status).toBe(401);
      expect(() => t("groups.guide_link")).toThrow(
        'Missing translation for key "groups.guide_link"',
      );
      expect(() => t("holidays.col.start_date")).toThrow(
        'Missing translation for key "holidays.col.start_date"',
      );
    }));

  test("an unknown admin API route leaves public API copy unloaded", () =>
    withColdMessages(async () => {
      await enablePublicApi();

      const response = await adminGet("/api/admin/no-such-resource");

      expect(response.status).toBe(404);
      expect(() => t("payment.title")).toThrow(
        'Missing translation for key "payment.title"',
      );
    }));

  test("an admin segment leaves unrelated area copy unloaded", () =>
    withColdMessages(async () => {
      const response = await adminGet("/admin/listings");

      expect(response.status).toBe(200);
      expect(t("listings_table.add_listing")).toBe("Add Listing");
      expect(() => t("backup.page_title")).toThrow(
        'Missing translation for key "backup.page_title"',
      );
      expect(() => t("guide.title")).toThrow(
        'Missing translation for key "guide.title"',
      );
    }));

  test("the attendee segment loads its shared notes copy", () =>
    withColdMessages(async () => {
      const response = await adminGet("/admin/attendees");

      expect(response.status).toBe(200);
      expect(t("notes.add_link")).toBe("Add a note");
    }));

  test("the guide segment loads its own copy", () =>
    withColdMessages(async () => {
      const response = await adminGet("/admin/guide");

      expect(response.status).toBe(200);
      expect(t("guide.title")).toBe("Guide");
    }));

  test("the formatting page loads only formatting guide copy", () =>
    withColdMessages(async () => {
      const response = await adminGet("/admin/formatting");

      expect(response.status).toBe(200);
      expect(t("guide.sections.text_formatting")).toBe("Text Formatting");
      expect(() => t("guide.title")).toThrow(
        'Missing translation for key "guide.title"',
      );
    }));
});
