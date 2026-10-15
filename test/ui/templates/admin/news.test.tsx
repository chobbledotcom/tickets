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
import { withEnv } from "#test-utils/env.ts";
import { says } from "#test-utils/says.ts";
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

    says(html, 'href="/admin/site/news/new"');
    says(html, "Add News Post");
    says(html, '<div class="success" role="alert">News post removed.</div>');
    says(html, "<em>No news posts yet.</em>");
    assert(!html.includes("<table"));
  });

  test("renders populated news rows with edit, date, and delete links", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminNewsListPage([summary], OWNER_SESSION);

    says(html, "<th>Name</th><th>Published</th><th></th>");
    says(html, '<a href="/admin/site/news/17/edit">Launch &amp; Learn</a>');
    says(html, "<td>2026-01-02 03:04</td>");
    says(html, '<a href="/admin/site/news/17/delete">Delete</a>');
    assert(!html.includes("No news posts yet."));
  });

  test("renders every create field without an editable slug", () => {
    const html = adminNewsNewPage(OWNER_SESSION, "Name is required.");

    says(html, 'action="/admin/site/news"');
    says(html, "Name is required.");
    says(html, 'name="name"');
    says(html, 'name="meta_title"');
    says(html, 'name="meta_description"');
    says(html, 'name="snippet"');
    says(html, 'name="content"');
    assert(!html.includes('name="slug"'));
    says(html, "Create News Post");
    says(html, "/icons.svg#plus");
  });

  test("renders the edit form with all saved values and its public link", () => {
    const html = String(newsEditPanel(post));

    says(html, 'action="/admin/site/news/17/edit"');
    says(html, 'value="Launch &amp; Learn"');
    says(html, 'value="launch-learn"');
    says(html, 'href="/news/launch-learn"');
    says(html, 'value="Launch &lt;News&gt;"');
    says(html, "Launch details &amp; dates");
    says(html, "A short update.");
    says(html, "Full **launch** details &amp; more.");
    says(html, "Save Changes");
  });

  test("renders the delete form with the post name and rejected-submit error", () => {
    const html = adminNewsDeletePage(
      post,
      OWNER_SESSION,
      "Name did not match.",
    );

    says(html, 'action="/admin/site/news/17/delete"');
    says(html, "Name did not match.");
    says(
      html,
      "Type the post name &quot;Launch &amp; Learn&quot; to confirm deletion.",
    );
    says(
      html,
      'name="confirm_identifier" placeholder="Launch &amp; Learn" required',
    );
    says(html, "Delete News Post");
  });
});
