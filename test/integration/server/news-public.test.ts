import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { appendImageToItem, imagesTable } from "#db/images.ts";
import { handleRequest } from "#routes";
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
        assertStringIncludes(html, "<title>News - Acme Site</title>");
        // Both cards, newest first, each a link wrapping the shared card markup.
        assertStringIncludes(html, `href="/news/${newer.slug}"`);
        expect(newer.slug).toBe("2026-07-02-newer-post");
        assertStringIncludes(html, 'class="card news-card"');
        expect(html.indexOf("Newer Post")).toBeLessThan(
          html.indexOf("Older Post"),
        );
        assertStringIncludes(html, "Fresh snippet");
        assertStringIncludes(html, 'class="card-name"');
        // The first image renders as the card thumbnail.
        assertStringIncludes(html, "news hero-thumb.webp");
      }));

    test("the list page's title is just News when the site has no name", async () => {
      await createTestNewsPost("Nav-worthy");
      assertStringIncludes(
        await assertPublicHtml("/news"),
        "<title>News</title>",
      );
    });

    test("every public page advertises the news RSS feed", async () => {
      const html = await assertPublicHtml("/");
      assertStringIncludes(
        html,
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
        assertStringIncludes(html, "<h1>Big Launch</h1>");
        assertStringIncludes(html, "<strong>finally</strong>");
        assertStringIncludes(html, "<title>Launch | Acme - Acme Site</title>");
        assertStringIncludes(
          html,
          '<meta name="description" content="News about &quot;things&quot; &amp; fun" />',
        );
        // The title, the date, and the body all sit inside the one .prose block.
        assertStringIncludes(html, '<div class="prose"><h1>Big Launch</h1>');
        // The date reads as a plain date (no time) in italics.
        assertStringIncludes(
          html,
          '<p class="news-post-date"><em>Monday 15 June 2026</em></p>',
        );
        assert(
          !html.includes("14:30"),
          "the value should not contain the searched item",
        );
      }));

    test("falls back to the post name for the title; no meta tag when empty", async () => {
      const post = await createTestNewsPost("Plain Post");
      const html = await assertPublicHtml(`/news/${post.slug}`);
      assertStringIncludes(html, "<title>Plain Post</title>");
      assert(
        !html.includes('name="description"'),
        "the value should not contain the searched item",
      );
      // No images ⇒ no gallery at all.
      assert(
        !html.includes("news-gallery"),
        "the value should not contain the searched item",
      );
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
      assertStringIncludes(html, 'class="news-gallery-full"');
      assertStringIncludes(html, "solo.webp");
      assertStringIncludes(html, 'alt="Solo"');
      assert(
        !html.includes("news-gallery-thumb"),
        "the value should not contain the searched item",
      );
    });

    test("multiple images render the CSS-only gallery: first checked, one thumb per image", async () => {
      const post = await createTestNewsPost("Gallery Post");
      const first = await makeImage("First Pic");
      const second = await makeImage("Second Pic");
      await appendImageToItem(first.id, { id: post.id, kind: "news" });
      await appendImageToItem(second.id, { id: post.id, kind: "news" });

      const html = await assertPublicHtml(`/news/${post.slug}`);
      // Two radios sharing one group; only the first is checked.
      assertStringIncludes(html, 'id="news-gallery-0" name="news-gallery"');
      assertStringIncludes(html, 'id="news-gallery-1" name="news-gallery"');
      expect(html.match(/checked/g)).toHaveLength(1);
      expect(html.indexOf("checked")).toBeLessThan(
        html.indexOf('id="news-gallery-1"'),
      );
      // Full images use the full files; thumbs use the thumbnail files and
      // point their labels at the radios.
      assertStringIncludes(html, "first pic.webp");
      assertStringIncludes(html, "first pic-thumb.webp");
      assertStringIncludes(
        html,
        '<label class="news-gallery-thumb" for="news-gallery-0">',
      );
      assertStringIncludes(
        html,
        '<label class="news-gallery-thumb" for="news-gallery-1">',
      );
    });
  });
});
