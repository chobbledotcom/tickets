import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import {
  expectHtml,
  expectIncludesAll,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const fetchNewsRss = () => handleRequest(mockRequest("/feeds/news.rss"));

describeWithEnv("server (news RSS feed)", { db: true }, () => {
  test("redirects to admin when public site is disabled", async () => {
    expectRedirect(await fetchNewsRss(), /^\/admin\/login$/);
  });

  test("answers 404 with the site's not-found page when no posts exist", async () => {
    await enablePublicSite();
    const response = await fetchNewsRss();
    expect(response.headers.get("content-type")).toBe(
      "text/html; charset=utf-8",
    );
    await expectHtml(response, {
      contains: ["<title>Not Found</title>", "<h1>Not Found</h1>"],
      notContains: ["<rss"],
      status: 404,
    });
  });

  test("channel uses the website title, defaulting to News", async () => {
    await enablePublicSite();
    await createTestNewsPost("Feed title post");
    let body = await (await fetchNewsRss()).text();
    expectIncludesAll(body, [
      "<title>News</title>",
      "<description>News from News</description>",
    ]);

    await settings.update.websiteTitle("Acme & Co");
    body = await (await fetchNewsRss()).text();
    expectIncludesAll(body, [
      "<title>Acme &amp; Co</title>",
      "<description>News from Acme &amp; Co</description>",
    ]);
  });

  test("lists posts newest first with escaped snippet, permalink, and pubDate", async () => {
    await enablePublicSite();
    await createTestNewsPost("Older news", {
      created: "2026-07-01T10:00:00.000Z",
      snippet: "old",
    });
    const newer = await createTestNewsPost("Tom & Jerry <launch>", {
      created: "2026-07-02T10:00:00.000Z",
      snippet: 'Snippet with "quotes" & ampersands',
    });
    const body = await (await fetchNewsRss()).text();
    expectIncludesAll(body, [
      "<title>Tom &amp; Jerry &lt;launch&gt;</title>",
      "<description>Snippet with &quot;quotes&quot; &amp; ampersands</description>",
    ]);
    // The permalink slug strips the punctuation from the name.
    expect(newer.slug).toBe("2026-07-02-tom-jerry-launch");
    const link = `https://localhost/news/${newer.slug}`;
    expectIncludesAll(body, [
      `<link>${link}</link>`,
      `<guid isPermaLink="true">${link}</guid>`,
      "<pubDate>Thu, 02 Jul 2026 10:00:00 GMT</pubDate>",
    ]);
    expect(body.indexOf("Jerry")).toBeLessThan(body.indexOf("Older news"));
  });

  test("a post without a snippet still carries an empty description", async () => {
    await enablePublicSite();
    await createTestNewsPost("Bare feed post");
    const body = await (await fetchNewsRss()).text();
    expectIncludesAll(body, [
      "<title>Bare feed post</title>",
      "<description></description>",
    ]);
  });
});
