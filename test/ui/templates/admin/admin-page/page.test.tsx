/**
 * The admin page shell: the layout and nav every admin page opens with, the
 * optional flash and action row it can carry, and the staff/agent variant.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Flash } from "#shared/forms/flash.tsx";
import {
  adminListingLink,
  flashDataPage,
} from "#templates/admin/admin-page.tsx";
import {
  AdminPage,
  renderAdminPageSpec,
} from "#templates/admin/admin-page-spec.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import type { AdminSession } from "#types";

const AGENT_SESSION: AdminSession = { adminLevel: "agent" };

const page = (props: Partial<Parameters<typeof AdminPage>[0]> = {}): string =>
  String(
    AdminPage({
      active: "/admin/settings",
      children: <p>Body</p>,
      session: OWNER_SESSION,
      title: "Page title",
      ...props,
    }),
  );

describe("the admin page shell", () => {
  beforeAll(setupAdminPageTest);

  test("titles the page and puts the body inside it", () => {
    const html = page();

    assertStringIncludes(html, "<title>Page title</title>");
    assertStringIncludes(html, "<p>Body</p>");
  });

  test("names the content admin-page unless the caller names it", () => {
    assertStringIncludes(page(), 'class="page-regions admin-page"');
    assertStringIncludes(
      page({ contentClassName: "wide-page" }),
      'class="page-regions wide-page"',
    );
  });

  test("leaves the body class alone unless a class is given", () => {
    assertStringIncludes(page(), '<body data-page-family="admin">');
    assertStringIncludes(
      page({ bodyClass: "ticket-body" }),
      '<body class="ticket-body" data-page-family="admin">',
    );
  });

  test("previews the theme it is given", () => {
    assert(!page().includes('data-theme="dark"'));
    assertStringIncludes(page({ theme: "dark" }), 'data-theme="dark"');
  });

  test("shows the flash between the nav and the body", () => {
    const html = page({ flash: <Flash success="Saved" /> });

    assertStringIncludes(html, "Saved");
    expect(html.indexOf("Saved")).toBeLessThan(html.indexOf("<p>Body</p>"));
    expect(html.indexOf("</nav>")).toBeLessThan(html.indexOf("Saved"));
  });

  test("wraps an action row, and renders none when there is none", () => {
    assertStringIncludes(
      page({ actions: <a href="/admin/new">Add</a> }),
      '<p class="actions"><a href="/admin/new">Add</a></p>',
    );
    assert(!page().includes('<p class="actions">'));
  });
});

describe("the link to a listing's admin page", () => {
  beforeAll(setupAdminPageTest);

  test("names the listing and points at its own page", () => {
    const html = String(adminListingLink({ id: 12, name: "Gala Night" }));

    expect(html).toBe('<a href="/admin/listing/12">Gala Night</a>');
  });
});

describe("rendering an admin page to a string", () => {
  beforeAll(setupAdminPageTest);

  test("marks the nav link the page belongs to", () => {
    const html = renderAdminPageSpec({
      active: "/admin/settings",
      body: <p>Plain body</p>,
      session: OWNER_SESSION,
      title: "Plain page",
    });

    assertStringIncludes(html, "<title>Plain page</title>");
    assertStringIncludes(html, '<a class="active" href="/admin/settings">');
    assertStringIncludes(html, "<p>Plain body</p>");
  });
});

describe("the page staff and agents share", () => {
  beforeAll(setupAdminPageTest);

  const staffPage = (session: AdminSession): string =>
    renderAdminPageSpec({
      active: "/admin/deliveries",
      body: <p>Run sheet</p>,
      session,
      staff: { heading: <h1>For staff</h1> },
      title: "Deliveries",
    });

  test("gives staff the heading the caller passed", () => {
    const html = staffPage(OWNER_SESSION);

    assertStringIncludes(html, "<h1>For staff</h1>");
    assert(!html.includes('<header class="agent-header">'));
    assertStringIncludes(html, "<p>Run sheet</p>");
  });

  test("gives an agent the bare agent header instead", () => {
    const html = staffPage(AGENT_SESSION);

    assert(!html.includes("<h1>For staff</h1>"));
    assertStringIncludes(
      html,
      '<header class="agent-header"><h1>Deliveries</h1></header>',
    );
    assertStringIncludes(html, "<p>Run sheet</p>");
  });
});

describe("the data-page opener the backup and update dashboards share", () => {
  beforeAll(setupAdminPageTest);

  const opener = (active: string | undefined) =>
    flashDataPage<{ note: string }>("backup.page_title", active, ({ note }) => (
      <p>{note}</p>
    ));

  test("marks the nav section the caller names, and renders the body and notices", () => {
    const html = opener("/admin/backup")(
      OWNER_SESSION,
      { note: "Snapshot" },
      "Restore failed",
      "Backup saved",
    );

    assertStringIncludes(html, "<title>Database backup</title>");
    assertStringIncludes(html, 'class="active" href="/admin/backup"');
    assertStringIncludes(html, "<p>Snapshot</p>");
    assertStringIncludes(html, "Restore failed");
    assertStringIncludes(html, "Backup saved");
    expect(html.indexOf("Restore failed")).toBeLessThan(
      html.indexOf("<p>Snapshot</p>"),
    );
  });

  test("falls back to the settings section when the caller names none", () => {
    const html = opener(undefined)(OWNER_SESSION, { note: "Snapshot" });

    assertStringIncludes(html, 'class="active" href="/admin/settings"');
    assert(!html.includes('class="active" href="/admin/backup"'));
    assertStringIncludes(html, "<p>Snapshot</p>");
  });
});
