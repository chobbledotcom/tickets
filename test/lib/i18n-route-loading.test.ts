import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ensureMessageGroups, resetI18nForTest, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminGet } from "#test-utils/session.ts";

const withColdMessages = async (run: () => Promise<void>): Promise<void> => {
  resetI18nForTest(true);
  try {
    await run();
  } finally {
    await ensureMessageGroups(MESSAGE_GROUPS);
  }
};

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

  test("a public page loads public copy but not admin copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/"));

      expect(response.status).toBe(302);
      expect(t("common.yes")).toBe("Yes");
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    }));

  test("an unknown admin segment leaves admin copy unloaded", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/admin/not-a-page"));

      expect(response.status).toBe(404);
      expect(() => t("admin.dashboard.guide_link")).toThrow(
        'Missing translation for key "admin.dashboard.guide_link"',
      );
    }));

  test("the setup route loads setup copy", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/setup"));

      expect(response.status).toBe(302);
      expect(t("setup.title")).toBe("Setup");
    }));

  test("the scheduled route loads builder copy before its module", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(
        mockRequest("/scheduled", { method: "POST" }),
      );

      expect(response.status).toBe(200);
      expect(t("builder.site_builder_title")).toBe("Site Builder");
    }));

  test("the admin API loads every resource catalog before its modules", () =>
    withColdMessages(async () => {
      const { handleRequest } = await import("#routes");

      const response = await handleRequest(mockRequest("/api/admin/groups"));

      expect(response.status).toBe(401);
      expect(t("groups.guide_link")).toBe("Packages guide");
      expect(t("holidays.col.start_date")).toBe("Start Date");
    }));

  test("an admin segment leaves unrelated area copy unloaded", () =>
    withColdMessages(async () => {
      const response = await adminGet("/admin/listings");

      expect(response.status).toBe(200);
      expect(t("admin.dashboard.guide_link")).toBe("Dashboard guide");
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
});
