/**
 * The admin page shell: the layout and nav every admin page opens with, the
 * optional flash and action row it can carry, and the staff/agent variant.
 */

import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Flash } from "#shared/forms/flash.tsx";
import {
  AdminPage,
  adminListingLink,
  renderAdminPage,
  staffAdminPage,
} from "#templates/admin/admin-page.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";
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

    says(html, "<title>Page title</title>");
    says(html, "<p>Body</p>");
  });

  test("names the content admin-page unless the caller names it", () => {
    says(page(), 'class="page-regions admin-page"');
    says(
      page({ contentClassName: "wide-page" }),
      'class="page-regions wide-page"',
    );
  });

  test("leaves the body class alone unless a class is given", () => {
    says(page(), '<body data-page-family="admin">');
    says(
      page({ bodyClass: "ticket-body" }),
      '<body class="ticket-body" data-page-family="admin">',
    );
  });

  test("previews the theme it is given", () => {
    assert(!page().includes('data-theme="dark"'));
    says(page({ theme: "dark" }), 'data-theme="dark"');
  });

  test("shows the flash between the nav and the body", () => {
    const html = page({ flash: <Flash success="Saved" /> });

    says(html, "Saved");
    expect(html.indexOf("Saved")).toBeLessThan(html.indexOf("<p>Body</p>"));
    expect(html.indexOf("</nav>")).toBeLessThan(html.indexOf("Saved"));
  });

  test("wraps an action row, and renders none when there is none", () => {
    says(
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
    const html = renderAdminPage(
      "/admin/settings",
      OWNER_SESSION,
      "Plain page",
      <p>Plain body</p>,
    );

    says(html, "<title>Plain page</title>");
    says(html, '<a class="active" href="/admin/settings">');
    says(html, "<p>Plain body</p>");
  });
});

describe("the page staff and agents share", () => {
  beforeAll(setupAdminPageTest);

  const staffPage = (session: AdminSession): string =>
    staffAdminPage({
      active: "/admin/deliveries",
      children: <p>Run sheet</p>,
      session,
      staffHeading: <h1>For staff</h1>,
      title: "Deliveries",
    });

  test("gives staff the heading the caller passed", () => {
    const html = staffPage(OWNER_SESSION);

    says(html, "<h1>For staff</h1>");
    says(html, "<p>Run sheet</p>");
  });

  test("gives an agent the bare agent header instead", () => {
    const html = staffPage(AGENT_SESSION);

    assert(!html.includes("<h1>For staff</h1>"));
    says(html, "Deliveries");
    says(html, "<p>Run sheet</p>");
  });
});
