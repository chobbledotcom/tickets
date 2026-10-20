import { assert, assertStringIncludes } from "@std/assert";
import { describe, it as test } from "@std/testing/bdd";
import { MAX_EMAIL_TEMPLATE_LENGTH } from "#db/settings/constants.ts";
import { MAX_INPUT_LENGTH } from "#shared/limits.ts";
import { emailTemplateFields } from "#templates/components/email-template-fields.tsx";
import type { EmailContent } from "#templates/email/shared.ts";

const templates: EmailContent = {
  html: "<p>Your order</p>",
  subject: "Your tickets",
  text: "Your tickets",
};

const defaults: EmailContent = {
  html: "<p>Default</p>",
  subject: "Default subject",
  text: "Default text",
};

describe("emailTemplateFields", () => {
  const html = String(emailTemplateFields("admin")(templates, defaults));

  test("renders the subject input with the default as its placeholder", () => {
    assertStringIncludes(html, "<label>Subject<input");
    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="subject" placeholder="Default subject" type="text" value="Your tickets">`,
    );
  });

  test("renders the html body within the template length budget", () => {
    assertStringIncludes(html, "<label>HTML Body<textarea");
    assertStringIncludes(
      html,
      `<textarea data-default-tpl="&lt;p&gt;Default&lt;/p&gt;" id="admin_html" maxlength="${MAX_EMAIL_TEMPLATE_LENGTH}" name="html" placeholder="Leave blank to use default template" rows="8">&lt;p&gt;Your order&lt;/p&gt;</textarea>`,
    );
  });

  test("renders the plain-text body with fewer rows and the same budget", () => {
    assertStringIncludes(html, "<label>Plain Text Body<textarea");
    assertStringIncludes(
      html,
      `id="admin_text" maxlength="${MAX_EMAIL_TEMPLATE_LENGTH}" name="text" placeholder="Leave blank to use default template" rows="6">Your tickets</textarea>`,
    );
  });

  test("pairs each body with its edit-default link", () => {
    assertStringIncludes(
      html,
      '<a data-fill-default="admin_html" href="#"><small>Edit default template</small></a>',
    );
    assertStringIncludes(
      html,
      '<a data-fill-default="admin_text" href="#"><small>Edit default template</small></a>',
    );
  });

  test("keys the body ids and fill links by the template kind", () => {
    const confirmation = String(
      emailTemplateFields("confirmation")(templates, defaults),
    );

    assertStringIncludes(confirmation, 'id="confirmation_html"');
    assertStringIncludes(confirmation, 'id="confirmation_text"');
    assertStringIncludes(confirmation, 'data-fill-default="confirmation_html"');
    assert(!confirmation.includes('id="admin_'));
  });
});
