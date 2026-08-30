import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createNewsPost } from "#db/news-posts.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const makePost = (name: string) =>
  createNewsPost({
    content: `The full story of ${name}.`,
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
    expect(body).toContain("Big Launch");
  });

  test("a post page renders its content; an unknown slug 404s", async () => {
    await enablePublicSite();
    const post = await makePost("Behind The Scenes");
    const page = await handleRequest(mockRequest(`/news/${post.slug}`));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("The full story of Behind The Scenes.");

    const unknown = await handleRequest(mockRequest("/news/no-such-post"));
    expect(unknown.status).toBe(404);
  });
});
