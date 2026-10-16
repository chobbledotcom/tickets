/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { expect } from "@std/expect";
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

    expect(html).toContain("<p>owner</p>");
    expect(html).toContain(`<title>${t("admin.seeds.title")}</title>`);
  });

  test("shows the notices its route passes back", () => {
    expect(page(OWNER_SESSION, "It broke")).toContain("It broke");
    expect(page(OWNER_SESSION, undefined, "It worked")).toContain("It worked");
  });
});

describe("the other opener families", () => {
  beforeAll(setupAdminPageTest);

  test("the opts-bag page shows the bag's notices in their channels", () => {
    const html = flashOptsPage("admin.seeds.title", "/admin/settings")(
      OWNER_SESSION,
      { error: "Name is taken", success: "Saved" },
      <p>Body</p>,
    );

    expect(html).toContain('<div class="success" role="alert">Saved</div>');
    expect(html).toContain('class="error"');
    expect(html).toContain("Name is taken");
  });

  test("the error page shows its rejection over the body", () => {
    const html = errorAdminPage("admin.seeds.title", "/admin/settings")(
      OWNER_SESSION,
      "Date clashes",
    )(<p>Body</p>);

    expect(html).toContain('class="error"');
    expect(html).toContain("Date clashes");
    expect(html).toContain("<p>Body</p>");
  });

  test("the list page shows only a write's success notice", () => {
    const html = successListPage("admin.seeds.title", "/admin/settings", () => (
      <p>Body</p>
    ))([], OWNER_SESSION, "Invited");

    expect(html).toContain('<div class="success" role="alert">Invited</div>');
    expect(html).not.toContain('class="error"');
  });

  test("a family with no notices renders none", () => {
    const html = successListPage("admin.seeds.title", "/admin/settings", () => (
      <p>Body</p>
    ))([], OWNER_SESSION);

    expect(html).not.toContain('role="alert"');
  });
});
