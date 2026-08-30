import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { sitePages } from "#db/site-pages.ts";
import { wasActivityLogged as wasLogged } from "#test-utils/activity-log.ts";
import {
  expectErrorFlash,
  expectFlash,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withExpectedError } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("create", () => {
    test("creates a page and redirects to its editor", async () => {
      const response = await create("about");
      expectRedirect(response);
      expectFlash(response, "Page created", true);
      expect(await findPage("about")).toBeTruthy();
      expect(await wasLogged("Page 'Name about' created")).toBe(true);
    });

    test("rolls back the page when activity logging fails", async () => {
      await getDb().execute(`
        CREATE TRIGGER fail_page_activity_log
        BEFORE INSERT ON activity_log
        BEGIN
          SELECT RAISE(ABORT, 'activity log write failed');
        END
      `);

      const response = await withExpectedError(() => create("not-committed"));

      expect(response.status).toBe(503);
      expect((await sitePages.getAll()).length).toBe(0);
      // Nothing committed, so a lookup of the rolled-back slug fails loudly.
      await expect(findPage("not-committed")).rejects.toThrow(
        "page not-committed not found",
      );
    });

    test("rejects a missing slug", async () => {
      const { response } = await adminFormPost(BASE, { name: "No Slug" });
      expectRedirect(response);
      expect((await sitePages.getAll()).length).toBe(0);
    });

    test("rejects a reserved slug", async () => {
      const response = await create("contact");
      expectRedirect(response);
      expect((await sitePages.getAll()).length).toBe(0);
    });

    test("rejects a duplicate slug", async () => {
      await create("dup");
      const response = await create("dup");
      expectErrorFlash(response, "already in use by a listing, group, or page");
      expect(
        (await sitePages.getAll()).filter((r) => r.slug === "dup").length,
      ).toBe(1);
    });
  });
});
