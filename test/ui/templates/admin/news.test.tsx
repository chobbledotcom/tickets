import { assert, assertStringIncludes } from "@std/assert";
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

    assertStringIncludes(html, 'href="/admin/site/news/new"');
    assertStringIncludes(html, "Add News Post");
    assertStringIncludes(
      html,
      '<div class="success" role="alert">News post removed.</div>',
    );
    assertStringIncludes(html, "<em>No news posts yet.</em>");
    assert(!html.includes("<table"));
  });

  test("renders populated news rows with edit, date, and delete links", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminNewsListPage([summary], OWNER_SESSION);

    assertStringIncludes(html, "<th>Name</th><th>Published</th><th></th>");
    assertStringIncludes(
      html,
      '<a href="/admin/site/news/17/edit">Launch &amp; Learn</a>',
    );
    assertStringIncludes(html, "<td>2026-01-02 03:04</td>");
    assertStringIncludes(
      html,
      '<a href="/admin/site/news/17/delete">Delete</a>',
    );
    assert(!html.includes("No news posts yet."));
  });

  test("renders every create field without an editable slug", () => {
    const html = adminNewsNewPage(OWNER_SESSION, "Name is required.");

    assertStringIncludes(html, 'action="/admin/site/news"');
    assertStringIncludes(html, "Name is required.");
    assertStringIncludes(html, 'name="name"');
    assertStringIncludes(html, 'name="meta_title"');
    assertStringIncludes(html, 'name="meta_description"');
    assertStringIncludes(html, 'name="snippet"');
    assertStringIncludes(html, 'name="content"');
    assert(!html.includes('name="slug"'));
    assertStringIncludes(html, "Create News Post");
    assertStringIncludes(html, "/icons.svg#plus");
  });

  test("renders the edit form with all saved values and its public link", () => {
    const html = String(newsEditPanel(post));

    assertStringIncludes(html, 'action="/admin/site/news/17/edit"');
    assertStringIncludes(html, 'value="Launch &amp; Learn"');
    assertStringIncludes(html, 'value="launch-learn"');
    assertStringIncludes(html, 'href="/news/launch-learn"');
    assertStringIncludes(html, 'value="Launch &lt;News&gt;"');
    assertStringIncludes(html, "Launch details &amp; dates");
    assertStringIncludes(html, "A short update.");
    assertStringIncludes(html, "Full **launch** details &amp; more.");
    assertStringIncludes(html, "Save Changes");
  });

  test("renders the delete form with the post name and rejected-submit error", () => {
    const html = adminNewsDeletePage(
      post,
      OWNER_SESSION,
      "Name did not match.",
    );

    assertStringIncludes(html, 'action="/admin/site/news/17/delete"');
    assertStringIncludes(html, "Name did not match.");
    assertStringIncludes(
      html,
      "Type the post name &quot;Launch &amp; Learn&quot; to confirm deletion.",
    );
    assertStringIncludes(
      html,
      'name="confirm_identifier" placeholder="Launch &amp; Learn" required',
    );
    assertStringIncludes(html, "Delete News Post");
  });
});
