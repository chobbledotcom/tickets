/**
 * The admin-page spec: what the flash bag renders, which nav link it lights
 * up, where the body lands, and the form, list, and staff facets — the one
 * surface every admin page opens through.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { flashProps } from "#templates/admin/admin-page.tsx";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import type { AdminSession } from "#types";

const BODY = <p>Opener body</p>;

describe("the spec's flash bag", () => {
  beforeAll(setupAdminPageTest);

  test("shows the error it was given", () => {
    const html = renderAdminPageSpec({
      active: "/admin/settings",
      body: BODY,
      flash: { error: "Name is taken" },
      session: OWNER_SESSION,
      title: "Holiday",
    });

    expect(html).toContain("Name is taken");
  });

  test("shows the success notice only when there is one", () => {
    const withNotice = renderAdminPageSpec({
      active: "/admin/settings",
      body: BODY,
      flash: { success: "Holiday saved" },
      session: OWNER_SESSION,
      title: "Holidays",
    });
    const without = renderAdminPageSpec({
      active: "/admin/settings",
      body: BODY,
      session: OWNER_SESSION,
      title: "Holidays",
    });

    expect(withNotice).toContain("Holiday saved");
    expect(without).not.toContain("flash");
  });

  test("shows either notice, or neither", () => {
    const spec = (flash: { error?: string; success?: string }): string =>
      renderAdminPageSpec({
        active: "/admin/settings",
        body: BODY,
        flash,
        session: OWNER_SESSION,
        title: "Update",
      });

    expect(spec({ error: "It broke" })).toContain("It broke");
    expect(spec({ success: "It worked" })).toContain("It worked");
    expect(spec({})).not.toContain("flash");
  });

  test("keeps only the notices flashProps was given", () => {
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

describe("the spec's shell", () => {
  beforeAll(setupAdminPageTest);

  test("lights the nav link it names and places the body inside", () => {
    const html = renderAdminPageSpec({
      active: "/admin/users",
      body: BODY,
      session: OWNER_SESSION,
      title: "Holidays",
    });

    expect(html).toContain('<a class="active" href="/admin/users">');
    expect(html).toContain("<p>Opener body</p>");
  });

  test("renders the action row it is handed", () => {
    const html = renderAdminPageSpec({
      actions: <a href="/admin/holidays/new">Add</a>,
      active: "/admin/settings",
      body: BODY,
      session: OWNER_SESSION,
      title: "Holidays",
    });

    expect(html).toContain(
      '<p class="actions"><a href="/admin/holidays/new">Add</a></p>',
    );
  });

  test("previews the theme it is given", () => {
    const html = renderAdminPageSpec({
      active: "/admin/settings",
      body: BODY,
      session: OWNER_SESSION,
      theme: "dark",
      title: "Advanced",
    });

    expect(html).toContain('data-theme="dark"');
  });
});

describe("the spec's form facet", () => {
  beforeAll(setupAdminPageTest);

  const formSpec = (flash?: { error?: string; success?: string }): string =>
    renderAdminPageSpec({
      active: "/admin/settings",
      form: {
        action: "/admin/recalculate",
        fields: BODY,
        ...(flash !== undefined ? { flash } : {}),
      },
      session: OWNER_SESSION,
      title: "Recalculate",
    });

  test("posts the whole body to the action it was given", () => {
    const html = formSpec();

    expect(html).toContain('<form action="/admin/recalculate"');
    expect(html).toContain("<h1>Recalculate</h1>");
    expect(html).toContain("<p>Opener body</p>");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });

  test("carries the reason a submit was refused, inside the form", () => {
    const html = formSpec({ error: "Nothing to do" });

    expect(html).toContain("Nothing to do");
    expect(html.indexOf("Nothing to do")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });

  test("heads the form with its title, then any notice", () => {
    const html = formSpec({ success: "Saved" });

    expect(html).toContain("<h1>Recalculate</h1>");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("Saved"),
    );
  });
});

describe("the spec's list facet", () => {
  beforeAll(setupAdminPageTest);

  const listSpec = (items: string[]): string =>
    renderAdminPageSpec({
      active: "/admin/groups",
      list: {
        columns: [
          { cell: (name) => <p>{name}</p>, header: () => "Name", key: "name" },
        ],
        empty: <p>Nothing yet</p>,
        guideFooter: <a href="/admin/guide">Guide</a>,
        intro: <h2>Groups</h2>,
        items,
      },
      session: OWNER_SESSION,
      title: "Groups",
    });

  test("renders the table when items exist and the empty note when not", () => {
    const full = listSpec(["one", "two"]);

    expect(full).toContain("<h2>Groups</h2>");
    expect(full).toContain("<p>one</p>");
    expect(full).toContain('<a href="/admin/guide">Guide</a>');
    expect(full).not.toContain("Nothing yet");

    const empty = listSpec([]);

    expect(empty).toContain("Nothing yet");
    expect(empty).toContain('<a href="/admin/guide">Guide</a>');
  });
});

describe("pages built on the spec", () => {
  beforeAll(setupAdminPageTest);

  /** The data-bound shape: the page binds its body to the loaded data and
   *  carries the notices its route passes back (backup, builder, update). */
  const dataPage = (
    session: AdminSession,
    rows: string[],
    error?: string,
    success?: string,
  ): string =>
    renderAdminPageSpec({
      active: "/admin/backup",
      body: <p>{rows.join(", ")}</p>,
      flash: { error, success },
      session,
      title: t("backup.page_title"),
    });

  test("titles itself from the message catalog and renders its data", () => {
    const html = dataPage(OWNER_SESSION, ["first", "second"]);

    expect(html).toContain(`<title>${t("backup.page_title")}</title>`);
    expect(html).toContain("<p>first, second</p>");
    expect(html).toContain('<a class="active" href="/admin/backup">');
  });

  test("carries the notices its route passes back", () => {
    expect(dataPage(OWNER_SESSION, [], "It broke")).toContain("It broke");
    expect(dataPage(OWNER_SESSION, [], undefined, "It worked")).toContain(
      "It worked",
    );
  });

  /** The opts-bag shape: the page takes its notices in one object
   *  (users, site). */
  const optsPage = (
    session: AdminSession,
    opts: { error?: string; success?: string },
  ): string =>
    renderAdminPageSpec({
      active: "/admin/users",
      body: BODY,
      flash: { error: opts.error, success: opts.success },
      session,
      title: "Users",
    });

  test("reads the error and the success out of the bag", () => {
    expect(optsPage(OWNER_SESSION, { error: "It broke" })).toContain(
      "It broke",
    );
    expect(optsPage(OWNER_SESSION, { success: "It worked" })).toContain(
      "It worked",
    );
    expect(optsPage(OWNER_SESSION, {})).toContain(
      '<a class="active" href="/admin/users">',
    );
  });

  /** The collection shape: the body receives both the items and the viewer
   *  (groups, logistics). */
  const collectionPage = (
    items: string[],
    session: AdminSession,
    successMessage?: string,
  ): string =>
    renderAdminPageSpec({
      active: "/admin/groups",
      body: (
        <p>
          {items.length} for {session.adminLevel}
        </p>
      ),
      flash: { success: successMessage },
      session,
      title: t("terms.groups"),
    });

  test("hands the body both the items and the viewer", () => {
    const html = collectionPage(["one", "two"], OWNER_SESSION);

    expect(html).toContain("<p>2 for owner</p>");
    expect(html).toContain(`<title>${t("terms.groups")}</title>`);
    expect(html).toContain('<a class="active" href="/admin/groups">');
  });

  test("shows the notice a write left behind", () => {
    expect(collectionPage([], OWNER_SESSION, "Group deleted")).toContain(
      "Group deleted",
    );
  });

  /** The single-form shape: the page binds its body to the viewer and its
   *  notices come back from the route (seeds, catalog import). */
  const formPage = (
    session: AdminSession,
    error?: string,
    success?: string,
  ): string =>
    renderAdminPageSpec({
      active: "/admin/settings",
      body: <p>{session.adminLevel}</p>,
      flash: { error, success },
      session,
      title: t("admin.seeds.title"),
    });

  test("hands the body the viewer and titles itself from the catalog", () => {
    const html = formPage(OWNER_SESSION);

    expect(html).toContain("<p>owner</p>");
    expect(html).toContain(`<title>${t("admin.seeds.title")}</title>`);
  });

  test("shows the notices its route passes back", () => {
    expect(formPage(OWNER_SESSION, "It broke")).toContain("It broke");
    expect(formPage(OWNER_SESSION, undefined, "It worked")).toContain(
      "It worked",
    );
  });
});
