/** The shared save, paths, image handlers and routes of a Site content
 * record. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { contentPagePaths, saveContent } from "#routes/admin/content-save.ts";
import { newsRecord } from "#shared/records/news.ts";
import { sitePageRecord } from "#shared/records/site-pages.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { expectAreaRoutes } from "#test-utils/area-routes.ts";
import { expectRedirectWithFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import {
  adminFormPost,
  createTestManagerSession,
  postFormAs,
} from "#test-utils/session.ts";

const saved = {
  flashMessage: "Saved it",
  logMessage: "Wrote the thing",
  path: "/admin/site/news/7/edit",
};

describeWithEnv("content save", { db: true, storage: "cdn" }, () => {
  test("logs the write and redirects with its flash", async () => {
    const response = await saveContent(
      () => Promise.resolve(7),
      (value) => ({ ...saved, path: `/admin/site/news/${value}/edit` }),
    );

    expectRedirectWithFlash("/admin/site/news/7/edit", "Saved it")(response);
    expect(await activityMessages()).toEqual(["Wrote the thing"]);
  });

  test("returns a refusal as it is and logs nothing", async () => {
    const refusal = new Response("no", { status: 400 });

    const response = await saveContent(
      () => Promise.resolve(refusal),
      () => saved,
    );

    expect(response).toBe(refusal);
    expect(await activityMessages()).toEqual([]);
  });

  test("names the new page and the Edit tab under the record's list", () => {
    expect(contentPagePaths(newsRecord).createErrorPath).toBe(
      "/admin/site/news/new",
    );
    expect(contentPagePaths(newsRecord).savePath(4)).toBe(
      "/admin/site/news/4/edit",
    );
    expect(contentPagePaths(sitePageRecord).savePath(2)).toBe(
      "/admin/site/pages/2/edit",
    );
  });

  test("binds the record routes and both image writes", async () => {
    await expectAreaRoutes(
      () => import("#routes/admin/news.ts"),
      [
        "GET /admin/site/news",
        "GET /admin/site/news/:id",
        "GET /admin/site/news/:id/:tab",
        "GET /admin/site/news/:id/delete",
        "GET /admin/site/news/new",
        "POST /admin/site/news",
        "POST /admin/site/news/:id/delete",
        "POST /admin/site/news/:id/edit",
        "POST /admin/site/news/:id/images",
        "POST /admin/site/news/:id/images/upload",
      ],
    );
  });

  test("links images and returns to the record's image path", async () => {
    const post = await createTestNewsPost("Pictured post");
    const image = await makeImage("News shot");

    const { response } = await adminFormPost(
      `/admin/site/news/${post.id}/images`,
      {
        image_ids: [String(image.id)],
      },
    );

    expectRedirectWithFlash(
      `/admin/site/news/${post.id}/images`,
      "Images updated",
    )(response);
  });

  test("keeps a manager out of a Site record's images", async () => {
    const post = await createTestNewsPost("Guarded post");
    const cookie = await createTestManagerSession();

    const response = await postFormAs(
      `/admin/site/news/${post.id}/images`,
      cookie,
      {
        image_ids: [],
      },
    );

    expect(response.status).toBe(403);
  });
});
