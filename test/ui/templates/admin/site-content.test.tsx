import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { collectionPage } from "#templates/admin/site-content.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

const renderPage = (readOnly: boolean): string => {
  using _env = withEnv({
    READ_ONLY_FROM: readOnly ? "2020-01-01T00:00:00.000Z" : undefined,
  });
  return collectionPage("site.pages", "/admin/site/pages")(
    OWNER_SESSION,
    "Pages loaded.",
    <p>Page list</p>,
  );
};

describe("site content collection page", () => {
  beforeAll(setupAdminPageTest);

  test("renders the create action while the site is writable", () => {
    const html = renderPage(false);

    expect(html).toContain('href="/admin/site/pages/new"');
    expect(html).toContain("Add Page");
    expect(html).toContain("Pages loaded.");
    expect(html).toContain("<p>Page list</p>");
  });

  test("hides the forbidden create action while the site is read-only", () => {
    const html = renderPage(true);

    expect(html).not.toContain('href="/admin/site/pages/new"');
    expect(html).not.toContain("Add Page");
    expect(html).toContain("<p>Page list</p>");
  });
});
