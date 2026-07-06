import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { newsPostsTable } from "#shared/db/news-posts.ts";
import { settings } from "#shared/db/settings.ts";
import { createTestNewsPost, describeWithEnv, mockRequest } from "#test-utils";

const fetchNewsRss = () => handleRequest(mockRequest("/feeds/news.rss"));

describeWithEnv("server (news RSS feed)", { db: true }, () => {
  test("redirects to admin when public site is disabled", async () => {
    const response = await fetchNewsRss();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin/login");
  });

  test("returns an empty RSS channel when no posts exist", async () => {
    await settings.update.showPublicSite(true);
    const response = await fetchNewsRss();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/rss+xml; charset=utf-8",
    );
    const body = await response.text();
    expect(body).toContain('<rss version="2.0">');
    expect(body).toContain("<link>https://localhost/news</link>");
    expect(body).not.toContain("<item>");
  });

  test("channel uses the website title, defaulting to News", async () => {
    await settings.update.showPublicSite(true);
    let body = await (await fetchNewsRss()).text();
    expect(body).toContain("<title>News</title>");
    expect(body).toContain("<description>News from News</description>");

    await settings.update.websiteTitle("Acme & Co");
    body = await (await fetchNewsRss()).text();
    expect(body).toContain("<title>Acme &amp; Co</title>");
    expect(body).toContain(
      "<description>News from Acme &amp; Co</description>",
    );
  });

  test("lists posts newest first with escaped snippet, permalink, and pubDate", async () => {
    await settings.update.showPublicSite(true);
    await newsPostsTable.insert({
      created: "2026-07-01T10:00:00.000Z",
      name: "Older news",
      snippet: "old",
    });
    const newer = await newsPostsTable.insert({
      created: "2026-07-02T10:00:00.000Z",
      name: "Tom & Jerry <launch>",
      snippet: 'Snippet with "quotes" & ampersands',
    });
    const body = await (await fetchNewsRss()).text();
    expect(body).toContain("<title>Tom &amp; Jerry &lt;launch&gt;</title>");
    expect(body).toContain(
      "<description>Snippet with &quot;quotes&quot; &amp; ampersands</description>",
    );
    const link = `https://localhost/news/${newer.id}`;
    expect(body).toContain(`<link>${link}</link>`);
    expect(body).toContain(`<guid isPermaLink="true">${link}</guid>`);
    expect(body).toContain("<pubDate>Thu, 02 Jul 2026 10:00:00 GMT</pubDate>");
    expect(body.indexOf("Jerry")).toBeLessThan(body.indexOf("Older news"));
  });

  test("a post without a snippet still carries an empty description", async () => {
    await settings.update.showPublicSite(true);
    await createTestNewsPost("Bare feed post");
    const body = await (await fetchNewsRss()).text();
    expect(body).toContain("<title>Bare feed post</title>");
    expect(body).toContain("<description></description>");
  });
});
