/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  errorAdminPage,
  errorFlash,
  flashFormPage,
  successAdminPage,
} from "#templates/admin/admin-page.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const BODY = <p>Opener body</p>;

describe("the error flash", () => {
  beforeAll(setupAdminPageTest);

  test("renders nothing when there is no error", () => {
    expect(errorFlash()).toBe(null);
  });

  test("renders the error it was given", () => {
    expect(String(errorFlash("Name is taken"))).toContain("Name is taken");
  });
});

describe("the list-page opener", () => {
  beforeAll(setupAdminPageTest);

  test("shows a success notice only when there is one", () => {
    const withNotice = successAdminPage("Holidays")(
      OWNER_SESSION,
      "Holiday saved",
    )(BODY);
    const without = successAdminPage("Holidays")(OWNER_SESSION)(BODY);

    expect(withNotice).toContain("Holiday saved");
    expect(without).not.toContain("flash");
  });

  test("renders the action row it is handed", () => {
    const html = successAdminPage("Holidays")(OWNER_SESSION)(
      BODY,
      <a href="/admin/holidays/new">Add</a>,
    );

    expect(html).toContain(
      '<p class="actions"><a href="/admin/holidays/new">Add</a></p>',
    );
  });

  test("defaults to the settings nav link", () => {
    expect(successAdminPage("Holidays")(OWNER_SESSION)(BODY)).toContain(
      '<a class="active" href="/admin/settings">',
    );
  });
});

describe("the edit-page and dashboard openers", () => {
  beforeAll(setupAdminPageTest);

  test("the edit opener shows the error it was given", () => {
    expect(
      errorAdminPage("Holiday")(OWNER_SESSION, "Name is taken")(BODY),
    ).toContain("Name is taken");
    expect(errorAdminPage("Holiday")(OWNER_SESSION)(BODY)).not.toContain(
      "flash",
    );
  });
});

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
