/**
 * Redirects: an owner maps a missing page to a new address, and a visitor to
 * the missing page gets a permanent redirect. The advanced settings page says
 * how many redirects exist without reading the table.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  addRedirect,
  countShown,
  deleteRedirect,
  LIST,
  listedRedirects,
  refusalOf,
  sentFrom,
  shopWith,
} from "#test/blackbox/redirects.ts";
import { addListing, openApi } from "#test/blackbox/seed.ts";
import {
  followed,
  sendLoggedOut,
  sendWithWrongToken,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const ADD = { action: LIST, field: "fromPath", page: `${LIST}/new` };

/** The message that the add page shows after the owner sends an add. */
const refusedWith = async (
  app: Awaited<ReturnType<typeof shopWith>>,
  fromPath: string,
  toUrl: string,
): Promise<string> => {
  const sent = await app.submit(`${LIST}/new`, { fromPath, toUrl }, LIST);
  expect(sent.location).toMatch(/^\/admin\/redirects\/new\?flash=/);
  return refusalOf(await followed(app, sent));
};

describeWithEnv("redirects", { db: true }, () => {
  describe("the advanced settings page", () => {
    test("says how many redirects exist, and links to the full page", async () => {
      const app = await shopWith();
      const page = (await app.get("/admin/settings-advanced")).html;
      expect(page).toContain("You have 0 redirects set up.");
      expect(page).toContain('<a href="/admin/redirects">Manage redirects</a>');
    });

    test("counts the rows after every add and delete", async () => {
      const app = await shopWith(["/one", "/a"]);
      const counts = [await countShown(app)];
      await addRedirect(app, "/two", "/b");
      await addRedirect(app, "/three", "/c");
      counts.push(await countShown(app));
      await deleteRedirect(app, "/two");
      counts.push(await countShown(app));
      expect(counts).toEqual(["1 redirect", "3 redirects", "2 redirects"]);
    });
  });

  describe("the owner adds a redirect", () => {
    test("the list shows the from page in lower case without its slash, and the to page as typed", async () => {
      const app = await shopWith();
      const landed = await addRedirect(app, "  /Old-Page/ ", "/New-Page?x=1");
      expect(landed.html).toContain("Redirect created");
      await addRedirect(app, "/away", "https://example.com/page?a=b#c");
      expect(await listedRedirects(app)).toEqual([
        ["/old-page", "/New-Page?x=1"],
        ["/away", "https://example.com/page?a=b#c"],
      ]);
      expect((await app.get("/admin/log")).html).toContain(
        "Redirect '/old-page' created",
      );
    });

    test("a wrong token and a visitor who is not logged in both add nothing", async () => {
      const app = await shopWith();
      expect((await sendWithWrongToken(app, ADD, "/x")).status).toBe(403);
      const outside = await sendLoggedOut(ADD, "/x");
      expect([outside.status, outside.headers.get("location")]).toEqual([
        302,
        "/admin",
      ]);
      expect(await listedRedirects(app)).toEqual([]);
    });
  });

  describe("the rules refuse an add and change nothing", () => {
    const REFUSALS: [string, string, string][] = [
      ["old", "/b", "from_not_a_path"],
      ["/old?x=1", "/b", "from_has_query"],
      ["/admin/users", "/b", "from_reserved"],
      ["/api/x", "/b", "from_reserved"],
      ["/a/../b", "/b", "from_unsafe"],
      ["/old", "javascript:alert(1)", "to_not_http"],
      ["/old", "https://a:b@example.com", "to_unsafe"],
      ["/old", "//evil.example", "to_unsafe"],
      ["/Old", "/old/?x=1", "same_page"],
    ];

    test("each refusal says why", async () => {
      const app = await shopWith();
      const said: string[] = [];
      for (const [from, to] of REFUSALS) {
        said.push(await refusedWith(app, from, to));
      }
      expect(said).toEqual(
        REFUSALS.map(([, , key]) => t(`redirects.error.${key}`)),
      );
      expect(await listedRedirects(app)).toEqual([]);
      expect(await countShown(app)).toBe("0 redirects");
    });

    test("an address longer than the box allows is refused", async () => {
      const app = await shopWith();
      expect(await refusedWith(app, `/${"a".repeat(250)}`, "/b")).toContain(
        "250 characters",
      );
    });

    test("a second redirect from the same page is refused, however it is written", async () => {
      const app = await shopWith(["/old", "/a"]);
      expect(await refusedWith(app, "/OLD/", "/b")).toBe(
        t("redirects.error.from_taken"),
      );
      expect(await listedRedirects(app)).toEqual([["/old", "/a"]]);
      expect(await countShown(app)).toBe("1 redirect");
    });

    test("a redirect to a page that already redirects is refused, so no loop can close", async () => {
      const app = await shopWith(["/a", "/b"], ["/b", "/c"]);
      for (const [from, to] of [
        ["/c", "/A/?x=1"],
        ["/d", "/a"],
      ] as const) {
        expect(await refusedWith(app, from, to)).toBe(
          t("redirects.error.to_is_redirect"),
        );
      }
      expect(await listedRedirects(app)).toHaveLength(2);
    });

    test("a redirect to another site can leave a page that already is a destination", async () => {
      const app = await shopWith(["/a", "/b"], ["/b", "https://example.com/a"]);
      expect(await listedRedirects(app)).toHaveLength(2);
    });
  });

  describe("a visitor asks for a missing page", () => {
    test("gets a 301 to the to page, whatever the case, trailing slash, and query", async () => {
      await shopWith(["/old-page", "/new-page?from=old"]);
      const sent = await Promise.all(
        ["/old-page", "/OLD-Page", "/old-page/", "/old-page?utm=x"].map(
          (path) => sentFrom(path),
        ),
      );
      expect(sent).toEqual(Array(4).fill([301, "/new-page?from=old"]));
    });

    test("gets a 301 to a whole external address as saved, and keeps the iframe marker only on this site", async () => {
      await shopWith(
        ["/away", "https://example.com/page?a=b#c"],
        ["/old", "/new"],
      );
      expect(await sentFrom("/away")).toEqual([
        301,
        "https://example.com/page?a=b#c",
      ]);
      expect(await sentFrom("/away?iframe=true")).toEqual([
        301,
        "https://example.com/page?a=b#c",
      ]);
      expect(await sentFrom("/old?iframe=true")).toEqual([
        301,
        "/new?iframe=true",
      ]);
    });

    test("is redirected from a listing address that no longer exists", async () => {
      await shopWith(["/ticket/old-slug", "/ticket/new-slug"]);
      expect(await sentFrom("/ticket/old-slug")).toEqual([
        301,
        "/ticket/new-slug",
      ]);
    });

    test("is redirected on a HEAD request and not on a POST", async () => {
      await shopWith(["/old", "/new"]);
      expect((await sentFrom("/old", "HEAD"))[0]).toBe(301);
      expect((await sentFrom("/old", "POST"))[0]).not.toBe(301);
    });

    test("still gets a 404 for a page with no redirect, and for the admin pages and the API", async () => {
      await shopWith(["/old", "/new"]);
      expect(
        (
          await Promise.all(
            ["/other", "/admin/nothing-here", "/api/nothing-here"].map((path) =>
              sentFrom(path),
            ),
          )
        ).map(([status]) => status),
      ).not.toContain(301);
      expect((await sentFrom("/other"))[0]).toBe(404);
    });

    test("is not redirected from a page that exists", async () => {
      const app = await shopWith();
      const listing = await addListing(await openApi(app), {
        max_attendees: 5,
        name: "Real",
      });
      await addRedirect(app, `/ticket/${listing.slug}`, "/elsewhere");
      expect((await sentFrom(`/ticket/${listing.slug}`))[0]).toBe(200);
    });

    test("follows a chain one step at a time", async () => {
      await shopWith(["/a", "/b"], ["/b", "/c"]);
      expect(
        await Promise.all(["/a", "/b", "/c"].map((path) => sentFrom(path))),
      ).toEqual([
        [301, "/b"],
        [301, "/c"],
        [404, null],
      ]);
    });
  });

  describe("the owner deletes a redirect", () => {
    test("the missing page answers 404 again and the count falls", async () => {
      const app = await shopWith(["/old", "/new"]);
      expect((await sentFrom("/old"))[0]).toBe(301);

      const sent = await deleteRedirect(app, "/old");
      expect((await followed(app, sent)).html).toContain("Redirect deleted");

      expect((await sentFrom("/old"))[0]).toBe(404);
      expect(await listedRedirects(app)).toEqual([]);
      expect(await countShown(app)).toBe("0 redirects");
    });

    test("a wrong confirmation deletes nothing", async () => {
      const app = await shopWith(["/old", "/new"]);
      expect((await deleteRedirect(app, "/old", "/other")).status).not.toBe(
        404,
      );
      expect(await listedRedirects(app)).toEqual([["/old", "/new"]]);
      expect((await sentFrom("/old"))[0]).toBe(301);
    });

    test("a redirect that is gone answers 404 on its delete page", async () => {
      const app = await shopWith();
      expect((await app.get(`${LIST}/999/delete`)).status).toBe(404);
    });

    test("the deleted page can get a redirect again", async () => {
      const app = await shopWith(["/old", "/new"]);
      await deleteRedirect(app, "/old");
      await addRedirect(app, "/old", "/newer");
      expect(await sentFrom("/old")).toEqual([301, "/newer"]);
    });
  });
});
