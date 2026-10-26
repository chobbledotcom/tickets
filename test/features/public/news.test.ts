import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createNewsPost } from "#db/news-posts.ts";
import { handleRequest } from "#routes";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { adminFormPost } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const makePost = (name: string, content?: string) =>
  createNewsPost({
    content: content ?? `The full story of ${name}.`,
    metaDescription: `${name} description`,
    metaTitle: `${name} title`,
    name,
    snippet: `${name} in one line`,
  });

describeWithEnv("public /news routes", { db: true }, () => {
  test("the list page 404s while no post exists", async () => {
    await enablePublicSite();
    const response = await handleRequest(mockRequest("/news"));
    expect(response.status).toBe(404);
  });

  test("the list page names the published post", async () => {
    await enablePublicSite();
    await makePost("Big Launch");
    const body = await (await handleRequest(mockRequest("/news"))).text();
    assertStringIncludes(body, "Big Launch");
  });

  test("a post page renders its content; an unknown slug 404s", async () => {
    await enablePublicSite();
    const post = await makePost("Behind The Scenes");
    const page = await handleRequest(mockRequest(`/news/${post.slug}`));
    expect(page.status).toBe(200);
    assertStringIncludes(
      await page.text(),
      "The full story of Behind The Scenes.",
    );

    const unknown = await handleRequest(mockRequest("/news/no-such-post"));
    expect(unknown.status).toBe(404);
  });

  test("a post's img#id image reference renders the image's uid URL", async () => {
    await enablePublicSite();
    const image = await makeImage("Hero");
    const post = await makePost("Poster Drop", `![Hero](img#${image.id})`);
    const page = await handleRequest(mockRequest(`/news/${post.slug}`));
    expect(page.status).toBe(200);
    const body = await page.text();
    assertStringIncludes(body, `src="/image/${image.filename}"`);
    assertStringIncludes(body, 'alt="Hero"');
    assert(!body.includes("/image/id/"));
  });

  test("the site footer's img#id reference renders the image's uid URL", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterPoster");
    await adminFormPost("/admin/settings/site-footer", {
      site_footer: `Thanks for coming.![FooterPoster](img#${image.id})`,
    });
    const post = await makePost("Footer Drop");
    const body = await (
      await handleRequest(mockRequest(`/news/${post.slug}`))
    ).text();
    assertStringIncludes(
      body,
      `<img src="/image/${image.filename}" alt="FooterPoster">`,
    );
  });

  test("the list page renders the footer's img#id reference", async () => {
    await enablePublicSite();
    const image = await makeImage("FooterIndex");
    await adminFormPost("/admin/settings/site-footer", {
      site_footer: `Thanks for coming.![FooterIndex](img#${image.id})`,
    });
    await makePost("Index Drop");
    const body = await (await handleRequest(mockRequest("/news"))).text();
    assertStringIncludes(
      body,
      `<img src="/image/${image.filename}" alt="FooterIndex">`,
    );
  });

  test("a post's unknown img#id reference falls back to the alt text", async () => {
    await enablePublicSite();
    const post = await makePost("Ghost Drop", "![Ghost](img#424242)");
    const page = await handleRequest(mockRequest(`/news/${post.slug}`));
    expect(page.status).toBe(200);
    const body = await page.text();
    assert(!body.includes("424242"));
    assert(!body.includes('<img src=""'));
    assertStringIncludes(body, "<p>Ghost</p>");
  });
});
