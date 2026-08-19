import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { getNewsPostById, getNewsPostCards } from "#db/news-posts.ts";
import { wasActivityLogged as wasLogged } from "#test-utils/activity-log.ts";
import {
  expectErrorFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { withExpectedError } from "#test-utils/mocks.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";
import type { NewsPost } from "#types";

const BASE = "/admin/site/news";

describeWithEnv("server (admin news)", { db: true }, () => {
  /** Create a post through the real create flow. */
  const create = (name: string, fields: Record<string, string> = {}) =>
    adminFormPost(BASE, { name, ...fields });

  const findPost = async (name: string): Promise<NewsPost> => {
    const card = (await getNewsPostCards()).find((c) => c.name === name);
    if (!card) throw new Error(`post ${name} not found`);
    return (await getNewsPostById(card.id))!;
  };

  describe("list + new", () => {
    testRequiresAuth(BASE);

    test("empty state renders the no-posts message", async () => {
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      expect(html).toContain("No news posts yet");
    });

    test("GET new renders the create form with a markdown content field", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expect(html).toContain("Create News Post");
      expect(html).toContain("data-markdown-preview");
      expect(html).toContain('name="snippet"');
    });

    test("the shared content fields render their input limits", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expect(html).toContain('maxlength="128" name="name"');
      expect(html).toContain('maxlength="64" name="meta_title"');
      expect(html).toContain('maxlength="160" name="meta_description"');
    });

    test("the list shows each post's name and published date, newest first", async () => {
      await create("First post");
      await create("Second post");
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      const second = await findPost("Second post");
      expect(html).toContain(`${BASE}/${second.id}/edit`);
      expect(html).toContain(`${BASE}/${second.id}/delete`);
      expect(html.indexOf("Second post")).toBeLessThan(
        html.indexOf("First post"),
      );
    });

    test("the Site sub-nav carries the News tab", async () => {
      await enablePublicSite();
      const html = await expectHtmlResponse(await adminGet(BASE), 200);
      expect(html).toContain('href="/admin/site/news"');
      expect(html).toContain('href="/admin/site/pages"');
    });
  });

  describe("create", () => {
    test("creates a post with every field and redirects to its editor", async () => {
      const { response } = await create("Launch", {
        content: "Body **text**",
        meta_description: "Meta description",
        meta_title: "Meta title",
        snippet: "Short summary",
      });
      const post = await findPost("Launch");
      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "News post created",
        true,
      )(response);
      expect(post.content).toBe("Body **text**");
      expect(post.meta_title).toBe("Meta title");
      expect(post.meta_description).toBe("Meta description");
      expect(post.snippet).toBe("Short summary");
      expect(post.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The permalink slug is auto-generated from the created date and name.
      expect(post.slug).toBe(`${post.created.slice(0, 10)}-launch`);
      expect(await wasLogged("News post 'Launch' created")).toBe(true);
    });

    test("stores omitted optional content fields as empty text", async () => {
      await create("No optional fields");
      const post = await findPost("No optional fields");
      expect(post.content).toBe("");
      expect(post.meta_title).toBe("");
      expect(post.meta_description).toBe("");
      expect(post.snippet).toBe("");
    });

    test("rolls back the post when activity logging fails", async () => {
      await getDb().execute(`
        CREATE TRIGGER fail_news_activity_log
        BEFORE INSERT ON activity_log
        BEGIN
          SELECT RAISE(ABORT, 'activity log write failed');
        END
      `);

      const { response } = await withExpectedError(() => create("Not saved"));

      expect(response.status).toBe(503);
      expect(await getNewsPostCards()).toEqual([]);
    });
  });

  describe("edit + update", () => {
    test("the edit tab renders the pre-filled form, editable slug, public link, and tab strip", async () => {
      const post = await createTestNewsPost("Editable", {
        snippet: "the snippet",
      });
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${post.id}/edit`),
        200,
      );
      expect(html).toContain('value="Editable"');
      expect(html).toContain("the snippet");
      // The slug is now an editable field pre-filled with the saved slug.
      expect(html).toContain(`name="slug"`);
      expect(html).toContain(`value="${post.slug}"`);
      // The public link sits under the slug field, opening in a new tab.
      expect(html).toContain(
        `Public link: <a href="/news/${post.slug}" rel="noopener" target="_blank">/news/${post.slug}</a>`,
      );
      // A guide footer sits at the bottom of the body.
      expect(html).toContain('class="guide-footer"');
      expect(html).toContain('href="/admin/guide#public-site"');
      // The shared tabbed strip carries Edit and Actions (Images is hidden
      // while storage is off — the live panel is covered in the news image
      // routes suite). Delete lives on the Actions tab, not the Edit form.
      expect(html).toContain('class="entity-tabs"');
      expect(html).toContain(`href="${BASE}/${post.id}/actions"`);
      expect(html).not.toContain(`href="${BASE}/${post.id}/images"`);
      expect(html).not.toContain("File storage is not configured.");
      expect(html).not.toContain(`${BASE}/${post.id}/delete`);
    });

    test("a bare /:id lands on the edit tab", async () => {
      const post = await createTestNewsPost("Bare");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${post.id}`),
        200,
      );
      expect(html).toContain('value="Bare"');
      expect(html).toContain('class="entity-tabs"');
    });

    test("the images tab 404s while storage is disabled", async () => {
      const post = await createTestNewsPost("No images tab");
      const response = await adminGet(`${BASE}/${post.id}/images`);
      expect(response.status).toBe(404);
    });

    test("an image POST with storage disabled bounces to the edit tab, not the hidden images tab", async () => {
      const post = await createTestNewsPost("Storage off post");
      const { response } = await adminFormPost(`${BASE}/${post.id}/images`, {
        image_ids: "1",
      });
      // The images tab is hidden with storage off, so the disabled-storage
      // message must land on the (visible) edit tab.
      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "File storage is not configured.",
        false,
      )(response);
    });

    test("the actions tab links to the delete confirmation", async () => {
      const post = await createTestNewsPost("With actions");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${post.id}/actions`),
        200,
      );
      expect(html).toContain(`href="${BASE}/${post.id}/delete"`);
    });

    test("the new page has no slug field (the permalink is auto-generated)", async () => {
      const html = await expectHtmlResponse(await adminGet(`${BASE}/new`), 200);
      expect(html).not.toContain('name="slug"');
      expect(html).not.toContain("/news/");
    });

    test("edit 404s for a missing id", async () => {
      const response = await adminGet(`${BASE}/9999/edit`);
      expect(response.status).toBe(404);
    });

    test("update rewrites the fields (slug included) and logs", async () => {
      const post = await createTestNewsPost("Before update");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        content: "new body",
        name: "After update",
        slug: "my-new-slug",
        snippet: "new snippet",
      });
      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "News post updated",
        true,
      )(response);
      const updated = await getNewsPostById(post.id);
      expect(updated?.name).toBe("After update");
      expect(updated?.snippet).toBe("new snippet");
      expect(updated?.content).toBe("new body");
      // The edited slug is persisted and now resolves the public page.
      expect(updated?.slug).toBe("my-new-slug");
      expect(await wasLogged("News post 'After update' updated")).toBe(true);
    });

    test("update rejects a slug already used by another post", async () => {
      const taken = await createTestNewsPost("Has the slug");
      const post = await createTestNewsPost("Wants the slug");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "Wants the slug",
        slug: taken.slug,
      });
      expectErrorFlash(response, "already used by another news post");
      // Nothing changed — the original slug is intact.
      const unchanged = await getNewsPostById(post.id);
      expect(unchanged?.slug).toBe(post.slug);
    });

    test("update lets a post keep its own slug", async () => {
      const post = await createTestNewsPost("Keeps slug");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "Keeps slug renamed",
        slug: post.slug,
      });
      expectRedirectWithFlash(
        `${BASE}/${post.id}/edit`,
        "News post updated",
        true,
      )(response);
      expect((await getNewsPostById(post.id))?.name).toBe("Keeps slug renamed");
    });

    test("update rejects a missing name and changes nothing", async () => {
      const post = await createTestNewsPost("Unchanged");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "",
        slug: "whatever",
      });
      expectRedirect(response, new RegExp(`^${BASE}/${post.id}/edit\\?`));
      expect((await getNewsPostById(post.id))?.name).toBe("Unchanged");
    });

    test("update rejects an invalid slug and changes nothing", async () => {
      const post = await createTestNewsPost("Slug guard");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "Slug guard",
        slug: "Not A Valid Slug!",
      });
      expectRedirect(response, new RegExp(`^${BASE}/${post.id}/edit\\?`));
      expect((await getNewsPostById(post.id))?.name).toBe("Slug guard");
    });
  });

  describe("delete", () => {
    test("GET renders the type-the-name confirmation page", async () => {
      const post = await createTestNewsPost("Confirm me");
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${post.id}/delete`),
        200,
      );
      expect(html).toContain("Delete News Post");
      expect(html).toContain("to confirm deletion");
      expect(html).toContain("Confirm me");
    });

    test("requires the exact post name to confirm", async () => {
      const post = await createTestNewsPost("Keep me");
      const { response } = await adminFormPost(`${BASE}/${post.id}/delete`, {
        confirm_identifier: "wrong name",
      });
      expectErrorFlash(response, "does not match");
      expect(await getNewsPostById(post.id)).not.toBeNull();
    });

    test("deletes on a matching confirmation and logs", async () => {
      const post = await createTestNewsPost("Delete me");
      const { response } = await adminFormPost(`${BASE}/${post.id}/delete`, {
        confirm_identifier: "Delete me",
      });
      expectRedirectWithFlash(BASE, "News post deleted", true)(response);
      expect(await getNewsPostById(post.id)).toBeNull();
      expect(await wasLogged("News post 'Delete me' deleted")).toBe(true);
    });
  });
});
