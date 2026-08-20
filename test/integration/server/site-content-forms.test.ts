import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { hasNewsPosts } from "#db/news-posts.ts";
import { sitePages } from "#db/site-pages.ts";
import {
  expectHtmlResponse,
  expectRedirectWithFlash,
  followRedirectWithFlash,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost } from "#test-utils/session.ts";

const expectInvalidCreate = async (
  path: string,
  fields: Record<string, string>,
  error: string,
): Promise<void> => {
  const { cookie, response } = await adminFormPost(path, fields);
  expectRedirectWithFlash(`${path}/new`, error, false)(response);
  const { handleRequest } = await import("#routes");
  const page = await followRedirectWithFlash(response, handleRequest, cookie);
  const html = await expectHtmlResponse(page, 200);
  expect(html.indexOf(error)).toBeGreaterThan(html.indexOf("<form"));
};

describeWithEnv("server (Site content forms)", { db: true }, () => {
  test("News create shows its validation error in the new form", async () => {
    await expectInvalidCreate(
      "/admin/site/news",
      { name: "" },
      "Post Name is required",
    );
    expect(await hasNewsPosts()).toBe(false);
  });

  test("Site Page create shows its validation error in the new form", async () => {
    await expectInvalidCreate(
      "/admin/site/pages",
      { slug: "no-name" },
      "Page Name is required",
    );
    expect(
      (await sitePages.getAll()).some((page) => page.slug === "no-name"),
    ).toBe(false);
  });
});
