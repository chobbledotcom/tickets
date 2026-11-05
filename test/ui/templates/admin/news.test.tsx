import { assert } from "@std/assert";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { BlindIndex } from "#crypto/sealed.ts";
import { settings } from "#db/settings.ts";
import {
  adminNewsDeletePage,
  adminNewsListPage,
  adminNewsNewPage,
  newsEditPanel,
} from "#templates/admin/news.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";
import type { NewsPost, NewsPostSummary } from "#types";

const summary: NewsPostSummary = {
  created: "2026-01-02T03:04:00.000Z",
  id: 17,
  name: "Launch & Learn",
  slug: "launch-learn",
  snippet: "A short update.",
};

const post: NewsPost = {
  ...summary,
  content: "Full **launch** details & more.",
  meta_description: "Launch details & dates",
  meta_title: "Launch <News>",
  slug_index: "test-news-index" as BlindIndex,
};

describe("admin news templates", () => {
  beforeAll(async () => {
    settings.setForTest({ timezone: "UTC" });
    await setupAdminPageTest();
  });
  afterAll(() => settings.clearTestOverride("timezone"));

  test("renders the empty news state with its action and success notice", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminNewsListPage([], OWNER_SESSION, "News post removed.");

    expectIncludesAll(html, [
      'href="/admin/site/news/new"',
      "Add News Post",
      '<div class="success" role="alert">News post removed.</div>',
      "<em>No news posts yet.</em>",
    ]);
    assert(!html.includes("<table"));
  });

  test("renders populated news rows with edit, date, and delete links", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminNewsListPage([summary], OWNER_SESSION);

    expectIncludesAll(html, [
      "<th>Name</th><th>Published</th><th></th>",
      '<a href="/admin/site/news/17/edit">Launch &amp; Learn</a>',
      "<td>2026-01-02 03:04</td>",
      '<a href="/admin/site/news/17/delete">Delete</a>',
    ]);
    assert(!html.includes("No news posts yet."));
  });

  test("renders every create field without an editable slug", () => {
    const html = adminNewsNewPage(OWNER_SESSION, "Name is required.");

    expectIncludesAll(html, [
      'action="/admin/site/news"',
      "Name is required.",
      'name="name"',
      'name="meta_title"',
      'name="meta_description"',
      'name="snippet"',
      'name="content"',
    ]);
    assert(!html.includes('name="slug"'));
    expectIncludesAll(html, ["Create News Post", "/icons.svg#plus"]);
  });

  test("renders the edit form with all saved values and its public link", () => {
    const html = String(newsEditPanel(post));

    expectIncludesAll(html, [
      'action="/admin/site/news/17/edit"',
      'value="Launch &amp; Learn"',
      'value="launch-learn"',
      'href="/news/launch-learn"',
      'value="Launch &lt;News&gt;"',
      "Launch details &amp; dates",
      "A short update.",
      "Full **launch** details &amp; more.",
      "Save Changes",
    ]);
  });

  test("renders the delete form with the post name and rejected-submit error", () => {
    const html = adminNewsDeletePage(
      post,
      OWNER_SESSION,
      "Name did not match.",
    );

    expectIncludesAll(html, [
      'action="/admin/site/news/17/delete"',
      "Name did not match.",
      "Type the post name &quot;Launch &amp; Learn&quot; to confirm deletion.",
      'name="confirm_identifier" placeholder="Launch &amp; Learn" required',
      "Delete News Post",
    ]);
  });
});
