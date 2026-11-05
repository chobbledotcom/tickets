import { assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { bulkEmailTemplateDeletePage } from "#templates/admin/bulk-email.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const template = { id: 9, subject: "March offers & news" };

describe("bulkEmailTemplateDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, intro, and prompt for the named template", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    expectIncludesAll(html, [
      'action="/admin/emails/templates/9/delete"',
      "<h1>Delete template</h1>",
      "Are you sure you want to delete the saved template with subject:",
      "with subject: <strong>March offers &amp; news</strong>",
      "<p>Type the template subject to confirm:</p>",
      'name="confirm_identifier" placeholder="March offers &amp; news" required',
    ]);
  });

  test("renders a dangerous submit button", () => {
    const html = bulkEmailTemplateDeletePage(template, OWNER_SESSION);

    expectIncludesAll(html, [
      '<button class="danger" type="submit">',
      "/icons.svg#trash-2",
      "Delete template",
    ]);
  });

  test("renders a rejected-submit error", () => {
    const html = bulkEmailTemplateDeletePage(
      template,
      OWNER_SESSION,
      "Template subject does not match.",
    );

    assertStringIncludes(html, "Template subject does not match.");
  });
});
