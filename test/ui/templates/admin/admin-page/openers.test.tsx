/**
 * The curried admin-page openers: what each one puts in the flash slot, which
 * nav link it lights up, and where the body it is handed ends up.
 */

import { assert } from "@std/assert";
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
import { says } from "#test-utils/says.ts";

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

    says(html, '<form action="/admin/recalculate"');
    says(html, "<h1>Recalculate</h1>");
    says(html, "<p>Opener body</p>");
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

    says(html, "Nothing to do");
  });

  test("heads the form with its title, then any notice", () => {
    const html = String(FormHeader({ success: "Saved", title: "Seeds" }));

    says(html, "<h1>Seeds</h1>");
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
    says(String(errorFlash("Name is taken")), "Name is taken");
  });
});

describe("the themed opener", () => {
  beforeAll(setupAdminPageTest);

  test("previews the site's own theme and lights up settings", () => {
    const html = themedAdminPage("Advanced")(OWNER_SESSION, "dark")(BODY);

    says(html, 'data-theme="dark"');
    says(html, '<a class="active" href="/admin/settings">');
    says(html, "<p>Opener body</p>");
  });

  test("takes another nav link when one is named", () => {
    const html = themedAdminPage("Debug", "/admin/users")(
      OWNER_SESSION,
      "light",
    )(BODY);

    says(html, '<a class="active" href="/admin/users">');
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

    says(withNotice, "Holiday saved");
    assert(!without.includes("flash"));
  });

  test("renders the action row it is handed", () => {
    const html = successAdminPage("Holidays")(OWNER_SESSION)(
      BODY,
      <a href="/admin/holidays/new">Add</a>,
    );

    says(html, '<p class="actions"><a href="/admin/holidays/new">Add</a></p>');
  });

  test("defaults to the settings nav link", () => {
    says(
      successAdminPage("Holidays")(OWNER_SESSION)(BODY),
      '<a class="active" href="/admin/settings">',
    );
  });
});

describe("the edit-page and dashboard openers", () => {
  beforeAll(setupAdminPageTest);

  test("the edit opener shows the error it was given", () => {
    says(
      errorAdminPage("Holiday")(OWNER_SESSION, "Name is taken")(BODY),
      "Name is taken",
    );
    assert(!errorAdminPage("Holiday")(OWNER_SESSION)(BODY).includes("flash"));
  });

  test("the dashboard opener shows either notice, or neither", () => {
    const bad = flashAdminPage("Update")(OWNER_SESSION, "It broke")(BODY);
    const good = flashAdminPage("Update")(
      OWNER_SESSION,
      undefined,
      "It worked",
    )(BODY);
    const quiet = flashAdminPage("Update")(OWNER_SESSION)(BODY);

    says(bad, "It broke");
    says(good, "It worked");
    assert(!quiet.includes("flash"));
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

    says(html, `<title>${t("backup.page_title")}</title>`);
    says(html, "<p>first, second</p>");
    says(html, '<a class="active" href="/admin/backup">');
  });

  test("carries the notices its route passes back", () => {
    says(page(OWNER_SESSION, [], "It broke"), "It broke");
    says(page(OWNER_SESSION, [], undefined, "It worked"), "It worked");
  });
});

describe("the pages that carry their notices in one bag", () => {
  beforeAll(setupAdminPageTest);

  test("reads the error and the success out of the bag", () => {
    const page = flashOptsPage("Users", "/admin/users");

    says(page(OWNER_SESSION, { error: "It broke" })(BODY), "It broke");
    says(page(OWNER_SESSION, { success: "It worked" })(BODY), "It worked");
    says(
      page(OWNER_SESSION, {})(BODY),
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

    says(html, "<p>2 for owner</p>");
    says(html, `<title>${t("terms.groups")}</title>`);
    says(html, '<a class="active" href="/admin/groups">');
  });

  test("shows the notice a write left behind", () => {
    says(page([], OWNER_SESSION, "Group deleted"), "Group deleted");
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

    says(html, "<p>owner</p>");
    says(html, `<title>${t("admin.seeds.title")}</title>`);
  });

  test("shows the notices its route passes back", () => {
    says(page(OWNER_SESSION, "It broke"), "It broke");
    says(page(OWNER_SESSION, undefined, "It worked"), "It worked");
  });
});
