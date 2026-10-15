import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { bulkEmailTemplateDeletePage } from "#templates/admin/bulk-email.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { says } from "#test-utils/says.ts";

const template = { id: 9, subject: "March offers & news" };

describe("bulkEmailTemplateDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, intro, and prompt for the named template", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    says(html, 'action="/admin/emails/templates/9/delete"');
    says(html, "<h1>Delete template</h1>");
    says(
      html,
      "Are you sure you want to delete the saved template with subject:",
    );
    says(html, "<strong>March offers &amp; news</strong>");
    says(html, "<p>Type the template subject to confirm:</p>");
    says(
      html,
      'name="confirm_identifier" placeholder="March offers &amp; news" required',
    );
  });

  test("renders a dangerous submit button", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    says(html, '<button class="danger" type="submit">');
    says(html, "/icons.svg#trash-2");
    says(html, "Delete template");
  });

  test("renders a rejected-submit error", () => {
    const html = bulkEmailTemplateDeletePage(
      template,
      OWNER_SESSION,
      "Template subject does not match.",
    );

    says(html, "Template subject does not match.");
  });
});
