// A Markdown box stores the indentation of its text, because four spaces
// start a code block. The page form and the page API both keep it.

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { records } from "#db/record-table.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithSitePages as describeWithEnv } from "#test-utils/feature-suites.ts";
import { adminFormPost, apiRequest } from "#test-utils/session.ts";
import { findPage } from "./site-pages/helpers.ts";

const CODE = "    const value = 7;";

describeWithEnv("Markdown content whitespace", { db: true }, () => {
  test("the page form keeps the indentation of a code block", async () => {
    await adminFormPost("/admin/site/pages", {
      content: `\n${CODE}\n`,
      name: "Code page",
      slug: "code-form",
    });
    const page = await findPage("code-form");
    expect(page.content).toBe(CODE);
    expect(renderMarkdown(page.content, new Map())).toContain("<pre><code>");
  });

  test("the page API keeps the indentation of a code block", async () => {
    const created = await assertJson<{ page: { id: number } }>(
      apiRequest("/api/admin/site-pages", {
        body: { content: `${CODE}\n`, name: "Code page", slug: "code-api" },
        method: "POST",
      }),
      201,
    );
    expect((await records.site_pages.find(created.page.id))!.content).toBe(
      CODE,
    );
  });

  test("a box with only spaces stores no text", async () => {
    await adminFormPost("/admin/site/pages", {
      content: "   \n  ",
      name: "Blank page",
      slug: "blank-form",
    });
    expect((await findPage("blank-form")).content).toBe("");
  });
});
