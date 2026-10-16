/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { flashFormPage } from "#templates/admin/admin-page.tsx";
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
