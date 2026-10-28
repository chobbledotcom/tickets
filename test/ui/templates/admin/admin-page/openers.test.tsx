/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  errorAdminPage,
  flashFormPage,
  flashOptsPage,
  successListPage,
} from "#templates/admin/admin-page.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

describe("the single-form page", () => {
  beforeAll(setupAdminPageTest);

  const page = flashFormPage(
    "admin.seeds.title",
    "/admin/settings",
    (session) => <p>{session.adminLevel}</p>,
  );

  test("hands the body the viewer and titles itself from the catalog", () => {
    const html = page(OWNER_SESSION);

    assertStringIncludes(html, "<p>owner</p>");
    assertStringIncludes(html, `<title>${t("admin.seeds.title")}</title>`);
  });

  test("shows the notices its route passes back", () => {
    assertStringIncludes(page(OWNER_SESSION, "It broke"), "It broke");
    assertStringIncludes(
      page(OWNER_SESSION, undefined, "It worked"),
      "It worked",
    );
  });
});

describe("the other opener families", () => {
  beforeAll(setupAdminPageTest);

  const seedsListPage = successListPage(
    "admin.seeds.title",
    "/admin/settings",
    () => ({ columns: [], empty: <p>Body</p>, items: [] }),
  );

  test("the opts-bag page shows the bag's notices in their channels", () => {
    const html = flashOptsPage("admin.seeds.title", "/admin/settings")(
      OWNER_SESSION,
      { error: "Name is taken", success: "Saved" },
      <p>Body</p>,
    );

    assertStringIncludes(html, '<div class="success" role="alert">Saved</div>');
    assertStringIncludes(html, 'class="error"');
    assertStringIncludes(html, "Name is taken");
  });

  test("the error page shows its rejection over the body", () => {
    const html = errorAdminPage("admin.seeds.title", "/admin/settings")(
      OWNER_SESSION,
      "Date clashes",
    )(<p>Body</p>);

    assertStringIncludes(html, 'class="error"');
    assertStringIncludes(html, "Date clashes");
    assertStringIncludes(html, "<p>Body</p>");
  });

  test("the list page shows only a write's success notice", () => {
    const html = seedsListPage([], OWNER_SESSION, "Invited");

    assertStringIncludes(
      html,
      '<div class="success" role="alert">Invited</div>',
    );
    assert(!html.includes('class="error"'));
  });

  test("a family with no notices renders none", () => {
    const html = seedsListPage([], OWNER_SESSION);

    assert(!html.includes('role="alert"'));
  });
});
