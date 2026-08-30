import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getSitePageById, sitePages } from "#db/site-pages.ts";
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
      expect(getHtml).toContain("Delete Page");

      const wrong = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirm_identifier: "nope",
      });
      expectRedirect(wrong.response);
      expect(await getSitePageById(page.id)).toBeTruthy();

      const right = await adminFormPost(`${BASE}/${page.id}/delete`, {
        confirm_identifier: page.name,
      });
      expectRedirect(right.response);
      expect(await getSitePageById(page.id)).toBeNull();
      expect(await wasLogged(`Page '${page.name}' deleted`)).toBe(true);
    });
  });

  describe("root reorder", () => {
    const order = async (): Promise<string[]> =>
      (await sitePages.getAll()).map((r) => r.slug);

    test("moves roots up and down; boundary is a no-op", async () => {
      await create("r1");
      await create("r2");
      await create("r3");
      expect(await order()).toEqual(["r1", "r2", "r3"]);

      // Move the middle page up (index 1 → 0): r2, r1, r3.
      const r2 = await findPage("r2");
      const up = await adminFormPost(`${BASE}/${r2.id}/move-up`, {});
      expectFlash(up.response, "Order updated", true);
      expect(await order()).toEqual(["r2", "r1", "r3"]);

      // Move r1 (now index 1) down: r2, r3, r1.
      const r1 = await findPage("r1");
      await adminFormPost(`${BASE}/${r1.id}/move-down`, {});
      expect(await order()).toEqual(["r2", "r3", "r1"]);

      // Moving the top page up is a no-op (boundary).
      const top = (await sitePages.getAll())[0]!;
      await adminFormPost(`${BASE}/${top.id}/move-up`, {});
      expect(await order()).toEqual(["r2", "r3", "r1"]);
    });
  });
});
