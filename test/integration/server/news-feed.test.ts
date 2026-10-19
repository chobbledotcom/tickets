import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

const fetchNewsRss = () => handleRequest(mockRequest("/feeds/news.rss"));

describeWithEnv("server (news RSS feed)", { db: true }, () => {
  test("redirects to admin when public site is disabled", async () => {
    const response = await fetchNewsRss();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login");
  });

  test("returns an empty RSS channel when no posts exist", async () => {
    await enablePublicSite();
    const response = await fetchNewsRss();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    const body = await response.text();
    assertStringIncludes(body, '<rss version="2.0">');
    assertStringIncludes(body, "<link>https://localhost/news</link>");
    assert(!body.includes("<item>"));
  });

  test("channel uses the website title, defaulting to News", async () => {
    await enablePublicSite();
    let body = await (await fetchNewsRss()).text();
    assertStringIncludes(body, "<title>News</title>");
    assertStringIncludes(body, "<description>News from News</description>");

    await settings.update.websiteTitle("Acme & Co");
    body = await (await fetchNewsRss()).text();
    assertStringIncludes(body, "<title>Acme &amp; Co</title>");
    assertStringIncludes(
      body,
      "<description>News from Acme &amp; Co</description>",
    );
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
    assertStringIncludes(body, "<title>Tom &amp; Jerry &lt;launch&gt;</title>");
    assertStringIncludes(
      body,
      "<description>Snippet with &quot;quotes&quot; &amp; ampersands</description>",
    );
    // The permalink slug strips the punctuation from the name.
    expect(newer.slug).toBe("2026-07-02-tom-jerry-launch");
    const link = `https://localhost/news/${newer.slug}`;
    assertStringIncludes(body, `<link>${link}</link>`);
    assertStringIncludes(body, `<guid isPermaLink="true">${link}</guid>`);
    assertStringIncludes(
      body,
      "<pubDate>Thu, 02 Jul 2026 10:00:00 GMT</pubDate>",
    );
    expect(body.indexOf("Jerry")).toBeLessThan(body.indexOf("Older news"));
  });

  test("a post without a snippet still carries an empty description", async () => {
    await enablePublicSite();
    await createTestNewsPost("Bare feed post");
    const body = await (await fetchNewsRss()).text();
    assertStringIncludes(body, "<title>Bare feed post</title>");
    assertStringIncludes(body, "<description></description>");
  });
});
