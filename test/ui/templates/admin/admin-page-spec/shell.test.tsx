/**
 * The admin page shell: the layout and nav every admin page opens with, the
 * optional flash, action row and image picker it can carry, and the
 * staff/agent variant.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { Flash } from "#shared/forms/flash.tsx";
import {
  AdminPage,
  renderAdminPageSpec,
} from "#templates/admin/admin-page-spec.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withStorageDisabled, withStorageEnabled } from "#test-utils/mocks.ts";
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

const pickerTemplates = (html: string): string[] =>
  [...html.matchAll(/<template id="md-image-picker">/g)].map(
    (match) => match[0],
  );

describe("the admin page shell", () => {
  beforeAll(setupAdminPageTest);

  test("titles the page and puts the body inside it", () => {
    const html = page();

    expectIncludesAll(html, ["<title>Page title</title>", "<p>Body</p>"]);
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

  test("carries one image picker only when storage is on", () => {
    expect(pickerTemplates(withStorageEnabled(page))).toEqual([
      '<template id="md-image-picker">',
    ]);
    expect(pickerTemplates(withStorageDisabled(page))).toEqual([]);
  });

  test("carries the shared modal and preview templates", () => {
    expectIncludesAll(page(), [
      '<template id="admin-modal">',
      '<template id="markdown-preview">',
    ]);
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

    expectIncludesAll(html, [
      "<title>Plain page</title>",
      '<a class="active" href="/admin/settings">',
      "<p>Plain body</p>",
    ]);
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
    expectIncludesAll(html, [
      '<header class="agent-header"><h1>Deliveries</h1></header>',
      "<p>Run sheet</p>",
    ]);
  });
});
