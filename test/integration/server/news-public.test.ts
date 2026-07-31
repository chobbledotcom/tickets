import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { appendImageToItem, imagesTable } from "#shared/db/images.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import {
  assertPublicHtml,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  featureSetting,
  useSetting,
  withSetting,
} from "#test-utils/settings.ts";

describeWithEnv("server (public news)", { db: true }, () => {
  describe("gate + resolution", () => {
    test("redirects to admin login before any lookup when the site is off", async () => {
      const post = await createTestNewsPost("Hidden while off");
      expectRedirect(
        await handleRequest(mockRequest("/news")),
        /^\/admin\/login$/,
      );
      expectRedirect(
        await handleRequest(mockRequest(`/news/${post.slug}`)),
        /^\/admin\/login$/,
      );
    });

    test("404s the list when no posts exist and unknown post ids", () =>
      withSetting(featureSetting("site"), async () => {
        expectStatus(404)(await handleRequest(mockRequest("/news")));
        expectStatus(404)(
          await handleRequest(mockRequest("/news/no-such-post")),
        );
      }));
  });

  describe("/news list", () => {
    useSetting(featureSetting("site"));

    test("lists posts newest first as linked cards with name, snippet, and first image", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
        await createTestNewsPost("Older Post", {
          created: "2026-07-01T10:00:00.000Z",
          snippet: "Old snippet",
        });
        const newer = await createTestNewsPost("Newer Post", {
          created: "2026-07-02T10:00:00.000Z",
          snippet: "Fresh snippet",
        });
        const image = await makeImage("News Hero");
        await appendImageToItem(image.id, {
          id: newer.id,
          kind: "news",
        });

        const html = await assertPublicHtml("/news");
        expect(html).toContain("<title>News - Acme Site</title>");
        // Both cards, newest first, each a link wrapping the shared card markup.
        expect(html).toContain(`href="/news/${newer.slug}"`);
        expect(newer.slug).toBe("2026-07-02-newer-post");
        expect(html).toContain('class="card news-card"');
        expect(html.indexOf("Newer Post")).toBeLessThan(
          html.indexOf("Older Post"),
        );
        expect(html).toContain("Fresh snippet");
        expect(html).toContain('class="card-name"');
        // The first image renders as the card thumbnail.
        expect(html).toContain("news hero-thumb.webp");
      }));

    // The News nav link waiting for the first post is told by the
    // telling-people-the-news story; only the bare-title contract stays here.
    test("the list page's title is just News when the site has no name", async () => {
      await createTestNewsPost("Nav-worthy");
      expect(await assertPublicHtml("/news")).toContain("<title>News</title>");
    });

    test("every public page advertises the news RSS feed", async () => {
      const html = await assertPublicHtml("/");
      expect(html).toContain(
        '<link rel="alternate" type="application/rss+xml" title="News" href="/feeds/news.rss" />',
      );
    });
  });

  describe("/news/:slug post page", () => {
    useSetting(featureSetting("site"));

    test("renders the name, date, markdown content, and SEO meta", () =>
      withSetting({ website_title: "Acme Site" }, async () => {
        const post = await createTestNewsPost("Big Launch", {
          content: "It is **finally** here",
          created: "2026-06-15T14:30:00.000Z",
          metaDescription: 'News about "things" & fun',
          metaTitle: "Launch | Acme",
        });
        const html = await assertPublicHtml(`/news/${post.slug}`);
        expect(html).toContain("<h1>Big Launch</h1>");
        expect(html).toContain("<strong>finally</strong>");
        expect(html).toContain("<title>Launch | Acme - Acme Site</title>");
        expect(html).toContain(
          '<meta name="description" content="News about &quot;things&quot; &amp; fun" />',
        );
        // The title, the date, and the body all sit inside the one .prose block.
        expect(html).toContain('<div class="prose"><h1>Big Launch</h1>');
        // The date reads as a plain date (no time) in italics.
        expect(html).toContain(
          '<p class="news-post-date"><em>Monday 15 June 2026</em></p>',
        );
        expect(html).not.toContain("14:30");
      }));

    test("falls back to the post name for the title; no meta tag when empty", async () => {
      const post = await createTestNewsPost("Plain Post");
      const html = await assertPublicHtml(`/news/${post.slug}`);
      expect(html).toContain("<title>Plain Post</title>");
      expect(html).not.toContain('name="description"');
      // No images ⇒ no gallery at all.
      expect(html).not.toContain("news-gallery");
    });

    test("a single image renders full-size with no thumbs or radios to swap", async () => {
      const post = await createTestNewsPost("One Image");
      // No alt text stored: the full image's alt falls back to the image name.
      const image = await imagesTable.insert({
        altText: "",
        filename: nonEmptyString("solo.webp"),
        filenameThumb: nonEmptyString("solo-thumb.webp"),
        name: "Solo",
      });
      await appendImageToItem(image.id, { id: post.id, kind: "news" });
      const html = await assertPublicHtml(`/news/${post.slug}`);
      expect(html).toContain('class="news-gallery-full"');
      expect(html).toContain("solo.webp");
      expect(html).toContain('alt="Solo"');
      expect(html).not.toContain("news-gallery-thumb");
    });

    test("multiple images render the CSS-only gallery: first checked, one thumb per image", async () => {
      const post = await createTestNewsPost("Gallery Post");
      const first = await makeImage("First Pic");
      const second = await makeImage("Second Pic");
      await appendImageToItem(first.id, { id: post.id, kind: "news" });
      await appendImageToItem(second.id, { id: post.id, kind: "news" });

      const html = await assertPublicHtml(`/news/${post.slug}`);
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
