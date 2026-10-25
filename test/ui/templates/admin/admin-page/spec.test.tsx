/**
 * The admin-page spec: what the flash bag renders, which nav link it lights
 * up, where the body lands, and the form, list, and staff facets — the one
 * surface every admin page opens through.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import {
  type AdminPageListPart,
  flashProps,
  renderAdminPageSpec,
} from "#templates/admin/admin-page-spec.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";
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

    assertStringIncludes(html, "Name is taken");
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

    assertStringIncludes(withNotice, "Holiday saved");
    assert(!without.includes("flash"));
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

    assertStringIncludes(spec({ error: "It broke" }), "It broke");
    assertStringIncludes(spec({ success: "It worked" }), "It worked");
    assert(!spec({}).includes("flash"));
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

    assertStringIncludes(html, '<a class="active" href="/admin/users">');
    assertStringIncludes(html, "<p>Opener body</p>");
  });

  test("renders the action row it is handed", () => {
    const html = renderAdminPageSpec({
      actions: <a href="/admin/holidays/new">Add</a>,
      active: "/admin/settings",
      body: BODY,
      session: OWNER_SESSION,
      title: "Holidays",
    });

    assertStringIncludes(
      html,
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

    assertStringIncludes(html, 'data-theme="dark"');
  });

  test("forwards custom shell and body classes", () => {
    const html = renderAdminPageSpec({
      active: "/admin/settings",
      body: BODY,
      bodyClass: "custom-body",
      contentClassName: "custom-shell",
      session: OWNER_SESSION,
      title: "Advanced",
    });

    assertStringIncludes(html, '<body class="custom-body"');
    assertStringIncludes(html, 'class="page-regions custom-shell"');
    assert(!html.includes('class="page-regions admin-page"'));
  });
});

describe("the spec's form facet", () => {
  beforeAll(setupAdminPageTest);

  const formSpec = (flash?: {
    error?: string;
    info?: string;
    success?: string;
  }): string =>
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

    assertStringIncludes(html, '<form action="/admin/recalculate"');
    assertStringIncludes(html, "<h1>Recalculate</h1>");
    assertStringIncludes(html, "<p>Opener body</p>");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });

  test("carries the reason a submit was refused, inside the form", () => {
    const html = formSpec({ error: "Nothing to do" });

    assertStringIncludes(html, "Nothing to do");
    expect(html.indexOf("Nothing to do")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });

  test("heads the form with its title, then any notice", () => {
    const html = formSpec({ success: "Saved" });

    assertStringIncludes(html, "<h1>Recalculate</h1>");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("Saved"),
    );
  });

  test("shows an info-only notice between the heading and the fields", () => {
    const html = formSpec({ info: "Copied the key" });

    assertStringIncludes(html, "Copied the key");
    expect(html.indexOf("<h1>Recalculate</h1>")).toBeLessThan(
      html.indexOf("Copied the key"),
    );
    expect(html.indexOf("Copied the key")).toBeLessThan(
      html.indexOf("<p>Opener body</p>"),
    );
  });
});

describe("the spec's list facet", () => {
  beforeAll(setupAdminPageTest);

  const listSpec = (
    items: string[],
    reorder?: AdminPageListPart<string>["reorder"],
  ): string =>
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
        ...(reorder !== undefined ? { reorder } : {}),
      },
      session: OWNER_SESSION,
      title: "Groups",
    });

  test("renders the table when items exist and the empty note when not", () => {
    const full = listSpec(["one", "two"]);

    assertStringIncludes(full, "<h2>Groups</h2>");
    assertStringIncludes(full, "<p>one</p>");
    assertStringIncludes(full, '<a href="/admin/guide">Guide</a>');
    assert(!full.includes("Nothing yet"));

    const empty = listSpec([]);

    assertStringIncludes(empty, "Nothing yet");
    assertStringIncludes(empty, '<a href="/admin/guide">Guide</a>');
  });

  test("renders the table for a single item, not the empty note", () => {
    const solo = listSpec(["only"]);

    assertStringIncludes(solo, "<p>only</p>");
    assert(!solo.includes("Nothing yet"));
  });

  test("adds the move column to a reorderable list", () => {
    using _writable = withEnv({ READ_ONLY_FROM: undefined });
    const html = listSpec(["one", "two"], {
      action: (name) => (direction) =>
        `/admin/groups/${name}/move-${direction}`,
      header: () => "Move",
    });

    assertStringIncludes(html, '<th class="col-reorder">');
    assertStringIncludes(html, "/admin/groups/one/move-down");
    assertStringIncludes(html, "/admin/groups/two/move-up");
    assert(!html.includes("/admin/groups/one/move-up"));
    assert(!html.includes("/admin/groups/two/move-down"));
    assertStringIncludes(html, "▲");
    assertStringIncludes(html, "▼");
  });

  test("omits the move column when the site is read-only", () => {
    using _readOnly = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = listSpec(["one", "two"], {
      action: (name) => (direction) =>
        `/admin/groups/${name}/move-${direction}`,
      header: () => "Move",
    });

    assert(!html.includes('class="col-reorder"'));
    assert(!html.includes("/admin/groups/one/move-up"));
    assert(!html.includes("/admin/groups/one/move-down"));
    assert(!html.includes("/admin/groups/two/move-up"));
    assert(!html.includes("/admin/groups/two/move-down"));
    assert(!html.includes("▲"));
    assert(!html.includes("▼"));
    assertStringIncludes(html, "<p>one</p>");
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

    assertStringIncludes(html, `<title>${t("backup.page_title")}</title>`);
    assertStringIncludes(html, "<p>first, second</p>");
    assertStringIncludes(html, '<a class="active" href="/admin/backup">');
  });

  test("carries the notices its route passes back", () => {
    assertStringIncludes(dataPage(OWNER_SESSION, [], "It broke"), "It broke");
    assertStringIncludes(
      dataPage(OWNER_SESSION, [], undefined, "It worked"),
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
    assertStringIncludes(
      optsPage(OWNER_SESSION, { error: "It broke" }),
      "It broke",
    );
    assertStringIncludes(
      optsPage(OWNER_SESSION, { success: "It worked" }),
      "It worked",
    );
    assertStringIncludes(
      optsPage(OWNER_SESSION, {}),
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

    assertStringIncludes(html, "<p>2 for owner</p>");
    assertStringIncludes(html, `<title>${t("terms.groups")}</title>`);
    assertStringIncludes(html, '<a class="active" href="/admin/groups">');
  });

  test("shows the notice a write left behind", () => {
    assertStringIncludes(
      collectionPage([], OWNER_SESSION, "Group deleted"),
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

    assertStringIncludes(html, "<p>owner</p>");
    assertStringIncludes(html, `<title>${t("admin.seeds.title")}</title>`);
  });

  test("shows the notices its route passes back", () => {
    assertStringIncludes(formPage(OWNER_SESSION, "It broke"), "It broke");
    assertStringIncludes(
      formPage(OWNER_SESSION, undefined, "It worked"),
      "It worked",
    );
  });
});
