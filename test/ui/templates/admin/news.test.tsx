import { expect } from "@std/expect";
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

    expect(html).toContain('href="/admin/site/news/new"');
    expect(html).toContain("Add News Post");
    expect(html).toContain(
      '<div class="success" role="alert">News post removed.</div>',
    );
    expect(html).toContain("<em>No news posts yet.</em>");
    expect(html).not.toContain("<table");
  });

  test("renders populated news rows with edit, date, and delete links", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = adminNewsListPage([summary], OWNER_SESSION);

    expect(html).toContain("<th>Name</th><th>Published</th><th></th>");
    expect(html).toContain(
      '<a href="/admin/site/news/17/edit">Launch &amp; Learn</a>',
    );
    expect(html).toContain("<td>2026-01-02 03:04</td>");
    expect(html).toContain('<a href="/admin/site/news/17/delete">Delete</a>');
    expect(html).not.toContain("No news posts yet.");
  });

  test("renders every create field without an editable slug", () => {
    const html = adminNewsNewPage(OWNER_SESSION, "Name is required.");

    expect(html).toContain('action="/admin/site/news"');
    expect(html).toContain("Name is required.");
    expect(html).toContain('name="name"');
    expect(html).toContain('name="meta_title"');
    expect(html).toContain('name="meta_description"');
    expect(html).toContain('name="snippet"');
    expect(html).toContain('name="content"');
    expect(html).not.toContain('name="slug"');
    expect(html).toContain("Create News Post");
    expect(html).toContain("/icons.svg#plus");
  });

  test("renders the edit form with all saved values and its public link", () => {
    const html = String(newsEditPanel(post));

    expect(html).toContain('action="/admin/site/news/17/edit"');
    expect(html).toContain('value="Launch &amp; Learn"');
    expect(html).toContain('value="launch-learn"');
    expect(html).toContain('href="/news/launch-learn"');
    expect(html).toContain('value="Launch &lt;News&gt;"');
    expect(html).toContain("Launch details &amp; dates");
    expect(html).toContain("A short update.");
    expect(html).toContain("Full **launch** details &amp; more.");
    expect(html).toContain("Save Changes");
  });

  test("renders the delete form with the post name and rejected-submit error", () => {
    const html = adminNewsDeletePage(
      post,
      OWNER_SESSION,
      "Name did not match.",
    );

    expect(html).toContain('action="/admin/site/news/17/delete"');
    expect(html).toContain("Name did not match.");
    expect(html).toContain(
      "Type the post name &quot;Launch &amp; Learn&quot; to confirm deletion.",
    );
    expect(html).toContain(
      'name="confirm_identifier" placeholder="Launch &amp; Learn" required',
    );
    expect(html).toContain("Delete News Post");
  });
});
