import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  getNewsPostById,
  getNewsPostCards,
  hasNewsPosts,
} from "#shared/db/news-posts.ts";
import type { NewsPost } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  createTestNewsPost,
  describeWithEnv,
  expectErrorFlash,
  expectHtmlResponse,
  expectRedirect,
  expectRedirectWithFlash,
  getAllActivityLog,
  testRequiresAuth,
} from "#test-utils";

/** True when the activity log holds an entry whose message equals `message`. */
const wasLogged = async (message: string): Promise<boolean> =>
  (await getAllActivityLog()).some((l) => l.message === message);

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
      expect(await wasLogged("News post 'Launch' created")).toBe(true);
    });

    test("rejects a missing name and creates nothing", async () => {
      const { response } = await create("");
      expectRedirect(response, /^\/admin\/site\/news\/new\?/);
      expect(await hasNewsPosts()).toBe(false);
    });
  });

  describe("edit + update", () => {
    test("edit renders the pre-filled form, images panel, and delete section", async () => {
      const post = await createTestNewsPost("Editable", {
        snippet: "the snippet",
      });
      const html = await expectHtmlResponse(
        await adminGet(`${BASE}/${post.id}/edit`),
        200,
      );
      expect(html).toContain('value="Editable"');
      expect(html).toContain("the snippet");
      // The shared images panel renders (storage is off in this suite, so it
      // shows the storage notice; the live panel is covered in the news image
      // routes suite).
      expect(html).toContain("<h2>Images</h2>");
      expect(html).toContain("File storage is not configured.");
      expect(html).toContain(`${BASE}/${post.id}/delete`);
    });

    test("edit 404s for a missing id", async () => {
      const response = await adminGet(`${BASE}/9999/edit`);
      expect(response.status).toBe(404);
    });

    test("update rewrites the fields and logs", async () => {
      const post = await createTestNewsPost("Before update");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        content: "new body",
        name: "After update",
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
      expect(await wasLogged("News post 'After update' updated")).toBe(true);
    });

    test("update rejects a missing name and changes nothing", async () => {
      const post = await createTestNewsPost("Unchanged");
      const { response } = await adminFormPost(`${BASE}/${post.id}/edit`, {
        name: "",
      });
      expectRedirect(response, new RegExp(`^${BASE}/${post.id}/edit\\?`));
      expect((await getNewsPostById(post.id))?.name).toBe("Unchanged");
    });
  });

  describe("delete", () => {
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
