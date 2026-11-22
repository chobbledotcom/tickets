import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { records } from "#db/record-table.ts";
import { sitePages } from "#db/site-pages.ts";
import { wasActivityLogged as wasLogged } from "#test-utils/activity-log.ts";
import {
  expectFlash,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { BASE, create, findPage } from "./helpers.ts";

describeWithEnv("server (admin site pages)", { db: true }, () => {
  describe("delete", () => {
    test("GET renders the confirmation, POST deletes on the right name", async () => {
      await create("goner");
      const page = await findPage("goner");
      const getHtml = await expectHtmlResponse(
        await adminGet(`${BASE}/${page.id}/delete`),
        200,
      );
      assertStringIncludes(getHtml, "Delete Page");

      const wrong = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirmIdentifier: "nope",
      });
      expectRedirect(wrong.response);
      expect(await records.site_pages.find(page.id)).toMatchObject({
        id: page.id,
        name: page.name,
      });

      const right = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirmIdentifier: page.name,
      });
      expectRedirect(right.response);
      expect(await records.site_pages.find(page.id)).toBeNull();
      expect(await wasLogged(`Page '${page.name}' deleted`)).toBe(true);
    });
  });

  describe("root reorder", () => {
    const order = async (): Promise<string[]> =>
      (await sitePages.getAll()).map((r) => r.slug);

    test("moves roots before and after their neighbours", async () => {
      await create("r1");
      await create("r2");
      await create("r3");
      expect(await order()).toEqual(["r1", "r2", "r3"]);

      // Move the middle page up (index 1 → 0): r2, r1, r3.
      const r2 = await findPage("r2");
      const r1 = await findPage("r1");
      const up = await adminFormPost(`${BASE}/${r2.id}/move-before`, {
        anchor: String(r1.id),
      });
      expectFlash(up.response, "Order updated", true);
      expect(await order()).toEqual(["r2", "r1", "r3"]);

      // Move r1 (now index 1) after r3: r2, r3, r1.
      const r3 = await findPage("r3");
      await adminFormPost(`${BASE}/${r1.id}/move-after`, {
        anchor: String(r3.id),
      });
      expect(await order()).toEqual(["r2", "r3", "r1"]);

      // Drop r1 before r2, two places up: r1, r2, r3.
      await adminFormPost(`${BASE}/${r1.id}/move-before`, {
        anchor: String(r2.id),
      });
      expect(await order()).toEqual(["r1", "r2", "r3"]);
    });
  });
});
