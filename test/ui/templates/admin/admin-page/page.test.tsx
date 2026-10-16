/**
 * The admin page shell: the layout and nav every admin page opens with, the
 * optional flash and action row it can carry, and the staff/agent variant.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Flash } from "#shared/forms/flash.tsx";
import {
  AdminPage,
  adminListingLink,
  flashDataPage,
} from "#templates/admin/admin-page.tsx";
import { renderAdminPageSpec } from "#templates/admin/admin-page-spec.tsx";
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

    expect(html).toContain("<title>Page title</title>");
    expect(html).toContain("<p>Body</p>");
  });

  test("names the content admin-page unless the caller names it", () => {
    expect(page()).toContain('class="page-regions admin-page"');
    expect(page({ contentClassName: "wide-page" })).toContain(
      'class="page-regions wide-page"',
    );
  });

  test("leaves the body class alone unless a class is given", () => {
    expect(page()).toContain('<body data-page-family="admin">');
    expect(page({ bodyClass: "ticket-body" })).toContain(
      '<body class="ticket-body" data-page-family="admin">',
    );
  });

  test("previews the theme it is given", () => {
    expect(page()).not.toContain('data-theme="dark"');
    expect(page({ theme: "dark" })).toContain('data-theme="dark"');
  });

  test("shows the flash between the nav and the body", () => {
    const html = page({ flash: <Flash success="Saved" /> });

    expect(html).toContain("Saved");
    expect(html.indexOf("Saved")).toBeLessThan(html.indexOf("<p>Body</p>"));
    expect(html.indexOf("</nav>")).toBeLessThan(html.indexOf("Saved"));
  });

  test("wraps an action row, and renders none when there is none", () => {
    expect(page({ actions: <a href="/admin/new">Add</a> })).toContain(
      '<p class="actions"><a href="/admin/new">Add</a></p>',
    );
    expect(page()).not.toContain('<p class="actions">');
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

    expect(html).toContain("<title>Plain page</title>");
    expect(html).toContain('<a class="active" href="/admin/settings">');
    expect(html).toContain("<p>Plain body</p>");
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

    expect(html).toContain("<h1>For staff</h1>");
    expect(html).not.toContain('<header class="agent-header">');
    expect(html).toContain("<p>Run sheet</p>");
  });

  test("gives an agent the bare agent header instead", () => {
    const html = staffPage(AGENT_SESSION);

    expect(html).not.toContain("<h1>For staff</h1>");
    expect(html).toContain(
      '<header class="agent-header"><h1>Deliveries</h1></header>',
    );
    expect(html).toContain("<p>Run sheet</p>");
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

    expect(html).toContain("<title>Database backup</title>");
    expect(html).toContain('class="active" href="/admin/backup"');
    expect(html).toContain("<p>Snapshot</p>");
    expect(html).toContain("Restore failed");
    expect(html).toContain("Backup saved");
    expect(html.indexOf("Restore failed")).toBeLessThan(
      html.indexOf("<p>Snapshot</p>"),
    );
  });

  test("falls back to the settings section when the caller names none", () => {
    const html = opener(undefined)(OWNER_SESSION, { note: "Snapshot" });

    expect(html).toContain('class="active" href="/admin/settings"');
    expect(html).not.toContain('class="active" href="/admin/backup"');
    expect(html).toContain("<p>Snapshot</p>");
  });
});
