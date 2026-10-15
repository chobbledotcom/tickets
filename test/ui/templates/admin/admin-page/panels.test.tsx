/**
 * The edit panels a record page's Edit tab is built from: the rejection
 * message above the form, and the route the form posts back to.
 */

import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { editPanel, recordEditPanel } from "#templates/admin/admin-page.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

const FIELDS = <input name="name" type="text" />;

describe("the edit panel", () => {
  beforeAll(setupAdminPageTest);

  test("shows the reason a save was refused, above the fields", () => {
    const html = String(editPanel("Name is taken")(FIELDS));

    says(html, "Name is taken");
    expect(html.indexOf("Name is taken")).toBeLessThan(html.indexOf("<input"));
  });

  test("shows the fields alone when nothing was refused", () => {
    const html = String(editPanel()(FIELDS));

    expect(html).toBe('<input name="name" type="text">');
  });
});

describe("a record's edit panel", () => {
  beforeAll(setupAdminPageTest);

  const panel = recordEditPanel("holidayEdit", "Save the holiday");

  test("posts to the route that edits the record it names", () => {
    const html = String(panel(9, undefined, FIELDS));

    says(html, 'action="/admin/holidays/9/edit"');
    says(html, "Save the holiday");
    says(html, '<input name="name" type="text">');
  });

  test("keeps the rejection message above the form", () => {
    const html = String(panel(9, "Name is taken", FIELDS));

    says(html, "Name is taken");
    expect(html.indexOf("Name is taken")).toBeLessThan(html.indexOf("<form"));
  });
});
