/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  adminFormPage,
  errorAdminPage,
  errorFlash,
  FormHeader,
  flashAdminPage,
  flashDataPage,
  flashFormPage,
  flashOptsPage,
  flashProps,
  successAdminPage,
  successListPage,
  themedAdminPage,
} from "#templates/admin/admin-page.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const BODY = <p>Opener body</p>;

describe("the form page and its header", () => {
  beforeAll(setupAdminPageTest);

  test("posts the whole body to the action it was given", () => {
    const html = adminFormPage({
      action: "/admin/recalculate",
      active: "/admin/settings",
      children: BODY,
      session: OWNER_SESSION,
      title: "Recalculate",
    });

    expect(html).toContain('<form action="/admin/recalculate"');
    expect(html).toContain("<h1>Recalculate</h1>");
    expect(html).toContain("<p>Opener body</p>");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });

  test("carries the reason a submit was refused", () => {
    const html = adminFormPage({
      action: "/admin/recalculate",
      active: "/admin/settings",
      children: BODY,
      error: "Nothing to do",
      session: OWNER_SESSION,
      title: "Recalculate",
    });

    expect(html).toContain("Nothing to do");
  });

  test("heads the form with its title, then any notice", () => {
    const html = String(FormHeader({ success: "Saved", title: "Seeds" }));

    expect(html).toContain("<h1>Seeds</h1>");
    expect(html.indexOf("<h1>Seeds</h1>")).toBeLessThan(html.indexOf("Saved"));
  });
});

describe("the flash props builder", () => {
  test("keeps only the notices it was given", () => {
    expect(flashProps()).toEqual({});
    expect(flashProps("Bad")).toEqual({ error: "Bad" });
    expect(flashProps(undefined, "Good")).toEqual({ success: "Good" });
    expect(flashProps(undefined, undefined, "Note")).toEqual({ info: "Note" });
    expect(flashProps("Bad", "Good", "Note")).toEqual({
      error: "Bad",
      info: "Note",
      success: "Good",
    });
  });
});

describe("the error flash", () => {
  beforeAll(setupAdminPageTest);

  test("renders nothing when there is no error", () => {
    expect(errorFlash()).toBe(null);
  });

  test("renders the error it was given", () => {
    expect(String(errorFlash("Name is taken"))).toContain("Name is taken");
  });
});

describe("the themed opener", () => {
  beforeAll(setupAdminPageTest);

  test("previews the site's own theme and lights up settings", () => {
    const html = themedAdminPage("Advanced")(OWNER_SESSION, "dark")(BODY);

    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('<a class="active" href="/admin/settings">');
    expect(html).toContain("<p>Opener body</p>");
  });

  test("takes another nav link when one is named", () => {
    const html = themedAdminPage("Debug", "/admin/users")(
      OWNER_SESSION,
      "light",
    )(BODY);

    expect(html).toContain('<a class="active" href="/admin/users">');
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

  test("the dashboard opener shows either notice, or neither", () => {
    const bad = flashAdminPage("Update")(OWNER_SESSION, "It broke")(BODY);
    const good = flashAdminPage("Update")(
      OWNER_SESSION,
      undefined,
      "It worked",
    )(BODY);
    const quiet = flashAdminPage("Update")(OWNER_SESSION)(BODY);

    expect(bad).toContain("It broke");
    expect(good).toContain("It worked");
    expect(quiet).not.toContain("flash");
  });
});

describe("the data-bound dashboard page", () => {
  beforeAll(setupAdminPageTest);

  const page = flashDataPage<string[]>(
    "backup.page_title",
    "/admin/backup",
    (rows) => <p>{rows.join(", ")}</p>,
  );

  test("titles itself from the message catalog and renders its data", () => {
    const html = page(OWNER_SESSION, ["first", "second"]);

    expect(html).toContain(`<title>${t("backup.page_title")}</title>`);
    expect(html).toContain("<p>first, second</p>");
    expect(html).toContain('<a class="active" href="/admin/backup">');
  });

  test("carries the notices its route passes back", () => {
    expect(page(OWNER_SESSION, [], "It broke")).toContain("It broke");
    expect(page(OWNER_SESSION, [], undefined, "It worked")).toContain(
      "It worked",
    );
  });
});

describe("the pages that carry their notices in one bag", () => {
  beforeAll(setupAdminPageTest);

  test("reads the error and the success out of the bag", () => {
    const page = flashOptsPage("Users", "/admin/users");

    expect(page(OWNER_SESSION, { error: "It broke" })(BODY)).toContain(
      "It broke",
    );
    expect(page(OWNER_SESSION, { success: "It worked" })(BODY)).toContain(
      "It worked",
    );
    expect(page(OWNER_SESSION, {})(BODY)).toContain(
      '<a class="active" href="/admin/users">',
    );
  });
});

describe("the collection page", () => {
  beforeAll(setupAdminPageTest);

  const page = successListPage<string[]>(
    "terms.groups",
    "/admin/groups",
    (items, session) => (
      <p>
        {items.length} for {session.adminLevel}
      </p>
    ),
  );

  test("hands the body both the items and the viewer", () => {
    const html = page(["one", "two"], OWNER_SESSION);

    expect(html).toContain("<p>2 for owner</p>");
    expect(html).toContain(`<title>${t("terms.groups")}</title>`);
    expect(html).toContain('<a class="active" href="/admin/groups">');
  });

  test("shows the notice a write left behind", () => {
    expect(page([], OWNER_SESSION, "Group deleted")).toContain("Group deleted");
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
