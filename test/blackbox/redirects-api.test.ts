/**
 * Redirects over the admin JSON API: add, list, and delete. A redirect has no
 * route to read or edit one by its id.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { t } from "#i18n";
import type { Api } from "#test/blackbox/api.ts";
import { addRedirect, sentFrom, shopWith } from "#test/blackbox/redirects.ts";
import { openApi } from "#test/blackbox/seed.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const PATH = "/api/admin/redirects";

const Row = v.strictObject({
  from_path: v.string(),
  id: v.number(),
  to_url: v.string(),
});
const RedirectAnswer = v.object({ redirect: Row });
const ListAnswer = v.object({ redirects: v.array(Row) });

const openShop = async (...redirects: [string, string][]) => {
  const app = await shopWith(...redirects);
  return { api: await openApi(app), app };
};

/** The id of the first redirect that the list route answers. */
const firstId = async (api: Api): Promise<number> => {
  const [first] = v.parse(ListAnswer, (await api.get(PATH)).body).redirects;
  if (first === undefined) throw new Error("The list holds no redirect.");
  return first.id;
};

/** The pairs [from page, to page] that the list route answers. */
const listed = async (api: Api): Promise<[string, string][]> => {
  const answer = await api.get(PATH);
  expect(answer.status).toBe(200);
  return v
    .parse(ListAnswer, answer.body)
    .redirects.map((row) => [row.from_path, row.to_url]);
};

/** The status and the error message of one add. */
const added = async (
  api: Api,
  body: Record<string, unknown>,
): Promise<[number, string | null]> => {
  const answer = await api.post(PATH, body);
  const error = v.safeParse(v.object({ error: v.string() }), answer.body);
  return [answer.status, error.success ? error.output.error : null];
};

describeWithEnv("redirects over the admin API", { db: true }, () => {
  describe("add", () => {
    test("answers 201 with the redirect as saved, and the visitor is redirected", async () => {
      const { api } = await openShop();
      const answer = await api.post(PATH, {
        from_path: " /Old/ ",
        to_url: "/new",
      });
      expect(answer.status).toBe(201);
      const { redirect } = v.parse(RedirectAnswer, answer.body);
      expect([redirect.from_path, redirect.to_url]).toEqual(["/old", "/new"]);
      expect(await sentFrom("/old")).toEqual([301, "/new"]);
    });

    test("answers 400 with the message of each rule, and adds nothing", async () => {
      const { api } = await openShop(["/taken", "/b"]);
      const bodies: [Record<string, unknown>, string][] = [
        [
          { from_path: "old", to_url: "/b" },
          t("redirects.error.from_not_a_path"),
        ],
        [
          { from_path: "/admin/x", to_url: "/b" },
          t("redirects.error.from_reserved"),
        ],
        [
          { from_path: "/x", to_url: "ftp://example.com" },
          t("redirects.error.to_not_http"),
        ],
        [{ from_path: "/x", to_url: "/X/" }, t("redirects.error.same_page")],
        [
          { from_path: "/TAKEN", to_url: "/c" },
          t("redirects.error.from_taken"),
        ],
        [
          { from_path: "/y", to_url: "/taken?z=1" },
          t("redirects.error.to_is_redirect"),
        ],
        [
          { from_path: `/${"a".repeat(250)}`, to_url: "/c" },
          t("redirects.error.too_long", { max: 250 }),
        ],
      ];
      const answers = await Promise.all(
        bodies.map(([body]) => added(api, body)),
      );
      expect(answers).toEqual(bodies.map(([, message]) => [400, message]));
      expect(await listed(api)).toEqual([["/taken", "/b"]]);
    });

    test("answers 400 for a body that is missing a field or is not text", async () => {
      const { api } = await openShop();
      const statuses = await Promise.all([
        added(api, { from_path: "/a" }),
        added(api, { from_path: 5, to_url: "/b" }),
      ]);
      expect(statuses.map(([status]) => status)).toEqual([400, 400]);
      expect(await listed(api)).toEqual([]);
    });

    test("of two requests that conflict and are sent together, exactly one is saved", async () => {
      const { api } = await openShop();
      const pairs = [
        [
          { from_path: "/a", to_url: "/b" },
          { from_path: "/b", to_url: "/a" },
        ],
        [
          { from_path: "/c", to_url: "/d" },
          { from_path: "/C", to_url: "/e" },
        ],
      ];
      for (const pair of pairs) {
        const answers = await Promise.all(pair.map((body) => added(api, body)));
        expect(answers.map(([status]) => status).sort()).toEqual([201, 400]);
      }
      expect(await listed(api)).toHaveLength(2);
    });
  });

  describe("list and delete", () => {
    test("the list answers every redirect in the order they were added, without the blind index", async () => {
      const { api } = await openShop(
        ["/b", "/1"],
        ["/a", "https://example.com"],
      );
      expect(await listed(api)).toEqual([
        ["/b", "/1"],
        ["/a", "https://example.com"],
      ]);
    });

    test("a delete removes the redirect when the confirmation names its from page", async () => {
      const { api, app } = await openShop(["/old", "/new"]);
      const path = `${PATH}/${await firstId(api)}`;
      expect(
        (await api.delete(path, { confirm_identifier: "/other" })).status,
      ).toBe(400);
      expect(await listed(api)).toHaveLength(1);

      expect(
        (await api.delete(path, { confirm_identifier: "/old" })).status,
      ).toBe(200);
      expect(await listed(api)).toEqual([]);
      expect((await sentFrom("/old"))[0]).toBe(404);
      expect((await app.get("/admin/settings-advanced")).html).toContain(
        "You have 0 redirects set up.",
      );
      expect(
        (await api.delete(path, { confirm_identifier: "/old" })).status,
      ).toBe(404);
    });
  });

  describe("the routes that a redirect does not serve", () => {
    test("have no route: no read by id and no edit", async () => {
      const { api, app } = await openShop(["/old", "/new"]);
      const id = await firstId(api);
      expect([
        await api.statusOf("GET", `${PATH}/${id}`),
        await api.statusOf("PUT", `${PATH}/${id}`, { to_url: "/x" }),
      ]).toEqual([404, 404]);
      await addRedirect(app, "/other", "/z");
      expect(await listed(api)).toEqual([
        ["/old", "/new"],
        ["/other", "/z"],
      ]);
    });

    test("a visitor with no key is refused", async () => {
      await openShop();
      expect((await sentFrom(PATH))[0]).toBe(401);
    });
  });
});
