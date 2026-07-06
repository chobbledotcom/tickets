import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { appendImageToItem } from "#shared/db/images.ts";
import { newsPostsTable } from "#shared/db/news-posts.ts";
import {
  assertPublicHtml,
  createTestNewsPost,
  describeWithEnv,
  expectRedirect,
  expectStatus,
  mockRequest,
  useSetting,
  withSetting,
} from "#test-utils";
import { makeImage } from "#test-utils/admin-images.ts";

describeWithEnv("server (public news)", { db: true }, () => {
  describe("gate + resolution", () => {
    test("redirects to admin login before any lookup when the site is off", async () => {
      await createTestNewsPost("Hidden while off");
      expectRedirect(
        await handleRequest(mockRequest("/news")),
        /^\/admin\/login$/,
      );
      expectRedirect(
        await handleRequest(mockRequest("/news/1")),
        /^\/admin\/login$/,
      );
    });

    test("404s the list when no posts exist and unknown post ids", () =>
      withSetting({ show_public_site: true }, async () => {
        expectStatus(404)(await handleRequest(mockRequest("/news")));
        expectStatus(404)(await handleRequest(mockRequest("/news/9999")));
      }));
  });

  describe("/news list", () => {
    useSetting({ show_public_site: true });

    test("lists posts newest first as linked cards with name, snippet, and first image", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
      await newsPostsTable.insert({
        created: "2026-07-01T10:00:00.000Z",
        name: "Older Post",
        snippet: "Old snippet",
      });
      const newer = await newsPostsTable.insert({
        created: "2026-07-02T10:00:00.000Z",
        name: "Newer Post",
        snippet: "Fresh snippet",
      });
      const image = await makeImage("News Hero");
      await appendImageToItem(image.id, {
        itemId: newer.id,
        itemType: "news",
      });

      const html = await assertPublicHtml("/news");
      expect(html).toContain("<title>News - Acme Site</title>");
      // Both cards, newest first, each a link wrapping the shared card markup.
      expect(html).toContain(`href="/news/${newer.id}"`);
      expect(html).toContain('class="card news-card"');
      expect(html.indexOf("Newer Post")).toBeLessThan(
        html.indexOf("Older Post"),
      );
      expect(html).toContain("Fresh snippet");
      expect(html).toContain('class="card-name"');
      // The first image renders as the card thumbnail.
      expect(html).toContain("news hero-thumb.webp");
    }));

    test("the nav shows a News link on other public pages once a post exists", async () => {
      let html = await assertPublicHtml("/");
      expect(html).not.toContain('href="/news"');
      await createTestNewsPost("Nav-worthy");
      html = await assertPublicHtml("/");
      expect(html).toContain('<a href="/news">News</a>');
      // Without a website title the list page's <title> is just "News".
      expect(await assertPublicHtml("/news")).toContain("<title>News</title>");
    });

    test("every public page advertises the news RSS feed", async () => {
      const html = await assertPublicHtml("/");
      expect(html).toContain(
        '<link rel="alternate" type="application/rss+xml" title="News" href="/feeds/news.rss" />',
      );
    });
  });

  describe("/news/:id post page", () => {
    useSetting({ show_public_site: true });

    test("renders the name, date, markdown content, and SEO meta", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
        const post = await createTestNewsPost("Big Launch", {
          content: "It is **finally** here",
          metaDescription: 'News about "things" & fun',
          metaTitle: "Launch | Acme",
        });
        const html = await assertPublicHtml(`/news/${post.id}`);
        expect(html).toContain("<h1>Big Launch</h1>");
        expect(html).toContain("<strong>finally</strong>");
        expect(html).toContain("<title>Launch | Acme - Acme Site</title>");
        expect(html).toContain(
          '<meta name="description" content="News about &quot;things&quot; &amp; fun" />',
        );
        expect(html).toContain('class="news-post-date"');
      }));

    test("falls back to the post name for the title; no meta tag when empty", async () => {
      const post = await createTestNewsPost("Plain Post");
      const html = await assertPublicHtml(`/news/${post.id}`);
      expect(html).toContain("<title>Plain Post</title>");
      expect(html).not.toContain('name="description"');
      // No images ⇒ no gallery at all.
      expect(html).not.toContain("news-gallery");
    });

    test("a single image renders full-size with no thumbs or radios to swap", async () => {
      const post = await createTestNewsPost("One Image");
      const image = await makeImage("Solo");
      await appendImageToItem(image.id, { itemId: post.id, itemType: "news" });
      const html = await assertPublicHtml(`/news/${post.id}`);
      expect(html).toContain('class="news-gallery-full"');
      expect(html).toContain("solo.webp");
      expect(html).not.toContain("news-gallery-thumb");
    });

    test("multiple images render the CSS-only gallery: first checked, one thumb per image", async () => {
      const post = await createTestNewsPost("Gallery Post");
      const first = await makeImage("First Pic");
      const second = await makeImage("Second Pic");
      await appendImageToItem(first.id, { itemId: post.id, itemType: "news" });
      await appendImageToItem(second.id, { itemId: post.id, itemType: "news" });

      const html = await assertPublicHtml(`/news/${post.id}`);
      // Two radios sharing one group; only the first is checked.
      expect(html).toContain('id="news-gallery-0" name="news-gallery"');
      expect(html).toContain('id="news-gallery-1" name="news-gallery"');
      expect(html.match(/checked/g)).toHaveLength(1);
      expect(html.indexOf("checked")).toBeLessThan(
        html.indexOf('id="news-gallery-1"'),
      );
      // Full images use the full files; thumbs use the thumbnail files and
      // point their labels at the radios.
      expect(html).toContain("first pic.webp");
      expect(html).toContain("first pic-thumb.webp");
      expect(html).toContain(
        '<label class="news-gallery-thumb" for="news-gallery-0">',
      );
      expect(html).toContain(
        '<label class="news-gallery-thumb" for="news-gallery-1">',
      );
    });
  });
});
