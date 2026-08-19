/**
 * The news record page: the shared Site-content tabs bound to a news post.
 * The POST sub-actions live in news.ts, so these ask what the GET surface
 * shows and who it shows it to.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { adminGet } from "#test-utils/session.ts";

describeWithEnv("the news post page", { db: true }, () => {
  test("opens on the edit form for the post named in the path", async () => {
    const post = await createTestNewsPost("Summer opening");

    const response = await adminGet(`/admin/site/news/${post.id}`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`action="/admin/site/news/${post.id}/edit"`);
    expect(html).toContain("Summer opening");
    expect(html).toContain('href="/admin/guide#public-site"');
  });

  test("titles the page with the post's own name", async () => {
    const post = await createTestNewsPost("Winter hours");

    const html = await (await adminGet(`/admin/site/news/${post.id}`)).text();

    expect(html).toContain("<h1>Winter hours</h1>");
  });

  test("opens the edit tab and leaves out pictures with no storage", async () => {
    // The images tab needs a storage zone. With none configured the tab is
    // absent rather than rendered and broken.
    const post = await createTestNewsPost("With pictures");

    const html = await (await adminGet(`/admin/site/news/${post.id}`)).text();

    expect(html).toContain(
      `<a aria-current="page" class="active" href="/admin/site/news/${post.id}/edit">Edit</a>`,
    );
    expect(html).toContain(`href="/admin/site/news/${post.id}/actions"`);
    expect(html).not.toContain(`href="/admin/site/news/${post.id}/images"`);
  });

  test("offers deleting the post on its actions tab", async () => {
    const post = await createTestNewsPost("Old news");

    const response = await adminGet(`/admin/site/news/${post.id}/actions`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain(`href="/admin/site/news/${post.id}/delete"`);
  });

  test("answers 404 for a post that is not there", async () => {
    expect((await adminGet("/admin/site/news/99999")).status).toBe(404);
  });
});
