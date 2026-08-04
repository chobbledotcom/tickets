import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { bulkEmailTemplateDeletePage } from "#templates/admin/bulk-email.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const template = { id: 9, subject: "March offers & news" };

describe("bulkEmailTemplateDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, intro, and prompt for the named template", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    expect(html).toContain('action="/admin/emails/templates/9/delete"');
    expect(html).toContain("<h1>Delete template</h1>");
    expect(html).toContain(
      "Are you sure you want to delete the saved template with subject:",
    );
    expect(html).toContain("<strong>March offers &amp; news</strong>");
    expect(html).toContain("<p>Type the template subject to confirm:</p>");
    expect(html).toContain(
      'name="confirm_identifier" placeholder="March offers &amp; news" required',
    );
  });

  test("renders a dangerous submit button", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    expect(html).toContain('<button class="danger" type="submit">');
    expect(html).toContain("/icons.svg#trash-2");
    expect(html).toContain("Delete template");
  });

  test("renders a rejected-submit error", () => {
    const html = bulkEmailTemplateDeletePage(
      template,
      OWNER_SESSION,
      "Template subject does not match.",
    );

    expect(html).toContain("Template subject does not match.");
  });
});
