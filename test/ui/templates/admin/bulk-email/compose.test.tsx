// Render pins for the bulk-email compose page. The page used to have only
// DB-backed HTTP coverage, so a whole-file mutation run left its labels,
// ternaries, and attribute strings unpinned (issue #2370).

import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { MAX_INPUT_LENGTH, MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  type BulkEmailComposeState,
  bulkEmailComposePage,
} from "#templates/admin/bulk-email.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const AUDIENCE_TARGET = { audience: "active", kind: "audience" } as const;

const composeState = (
  overrides: Partial<BulkEmailComposeState> = {},
): BulkEmailComposeState => ({
  canBulkSend: true,
  control: {
    label: "Audience",
    mode: "select",
    name: "audience",
    options: [
      { label: "Active listing attendees", value: "active" },
      { label: "All attendees", value: "all" },
    ],
    selected: "active",
  },
  copy: {
    heading: "Send a bulk email",
    intro: "Email your attendees about an upcoming listing or other news.",
  },
  disabledReason: "",
  draft: null,
  recipientCount: 4,
  selectedTemplateId: null,
  single: false,
  targetLabel: "Active listing attendees",
  templateLinkBase: "/admin/emails?audience=active",
  templates: [],
  ...overrides,
});

describe("bulkEmailComposePage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the heading, intro, form, and submit buttons", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());

    assertStringIncludes(html, "<h1>Send a bulk email</h1>");
    assertStringIncludes(
      html,
      '<div class="prose"><p>Email your attendees about an upcoming listing or other news.</p></div>',
    );
    assertStringIncludes(
      html,
      '<a class="active" href="/admin/emails">Emails</a>',
    );
    assertStringIncludes(html, 'href="/admin/guide#bulk-email"');
    assertStringIncludes(html, 'action="/admin/emails/preview"');
    assertStringIncludes(html, 'id="bulk-email"');
    assertStringIncludes(html, 'method="POST"');
    assertStringIncludes(html, '<button type="submit">Preview</button>');
    assertStringIncludes(html, 'formaction="/admin/emails/templates"');
    assertStringIncludes(html, ">Save as new template</span>");
    assertStringIncludes(html, ">Update template</span>");
    assertStringIncludes(html, "Bulk email guide");
  });

  test("renders the recipient selector with its selected option", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());

    assertStringIncludes(html, '<label>Audience<select name="audience">');
    assertStringIncludes(
      html,
      '<option selected value="active">Active listing attendees</option>',
    );
    assertStringIncludes(html, '<option value="all">All attendees</option>');
  });

  test("renders a fixed recipient as hidden inputs and a label", () => {
    const plural = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        control: { fields: [["listing_id", "7"]], mode: "fixed" },
        targetLabel: "Attendees of Gig",
      }),
    );
    assertStringIncludes(
      plural,
      '<input name="listing_id" type="hidden" value="7">',
    );
    assertStringIncludes(
      plural,
      "<strong>Recipients:</strong> Attendees of Gig",
    );
    assertStringIncludes(plural, "Attendees of Gig");

    const single = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        control: { fields: [["listing_id", "7"]], mode: "fixed" },
        single: true,
        targetLabel: "Attendees of Gig",
      }),
    );
    assertStringIncludes(
      single,
      "<strong>Recipient:</strong> Attendees of Gig",
    );
    assert(!single.includes("<strong>Recipients:</strong>"));
  });

  test("warns with the reason when provider sending is unavailable", () => {
    const html = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        canBulkSend: false,
        disabledReason: "You have not configured your own email provider",
      }),
    );
    assertStringIncludes(
      html,
      '<div class="prose"><p><strong>Heads up:</strong> You have not configured your own email provider',
    );
    assertStringIncludes(
      html,
      "email provider You can still compose and preview, then use the BCC email-app option on the preview page.",
    );
    assertStringIncludes(
      html,
      '<p class="small"><a href="/admin/settings-advanced#settings-email">',
    );
    assertStringIncludes(
      html,
      "Set up your email provider in advanced settings",
    );
  });

  test("keeps the warning off the page when sending is available", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());
    assert(!html.includes("Heads up"));
  });

  test("prefills the draft subject, body, and marketing checkbox", () => {
    const html = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        draft: {
          body: "Hello **world**",
          marketing: true,
          subject: "Spring sale",
          target: AUDIENCE_TARGET,
        },
      }),
    );
    assertStringIncludes(
      html,
      'name="subject" required type="text" value="Spring sale">',
    );
    assertStringIncludes(html, `maxlength="${MAX_INPUT_LENGTH}"`);
    assertStringIncludes(
      html,
      `data-markdown-preview maxlength="${MAX_TEXTAREA_LENGTH}" name="body" required>\nHello **world**</textarea>`,
    );
    assertStringIncludes(
      html,
      'checked name="marketing" type="checkbox" value="1"> This is a marketing email',
    );
    assertStringIncludes(
      html,
      '<fieldset class="checkboxes"><label><input checked name="marketing"',
    );
    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="subject" required type="text" value="Spring sale">`,
    );
  });

  test("leaves the draft fields empty when no draft is saved", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());
    assertStringIncludes(
      html,
      `<input autocomplete="off" maxlength="${MAX_INPUT_LENGTH}" name="subject" required type="text">`,
    );
    assertStringIncludes(html, `name="body" required>\n</textarea>`);
    assert(!html.includes('name="subject" required type="text" value='));
    assert(!html.includes('checked name="marketing"'));
  });

  test("leaves the subject value empty when the saved subject is blank", () => {
    const html = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        draft: {
          body: "",
          marketing: false,
          subject: "",
          target: AUDIENCE_TARGET,
        },
      }),
    );
    assert(!html.includes('name="subject" required type="text" value='));
  });

  test("counts recipients with singular and plural wording", () => {
    const single = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({ single: true }),
    );
    assertStringIncludes(
      single,
      '<div class="prose"><p>Preview to confirm the message before sending.</p>',
    );
    assert(!single.includes("This selection currently reaches"));

    const one = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({ recipientCount: 1 }),
    );
    assertStringIncludes(
      one,
      '<div class="prose"><p>This selection currently reaches <strong>1</strong> recipient.',
    );
    assert(!one.includes("recipients."));

    const many = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({ recipientCount: 4 }),
    );
    assertStringIncludes(many, "<strong>4</strong> recipients.");
  });

  test("lists saved templates with load and delete links", () => {
    const html = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        selectedTemplateId: 9,
        templates: [
          { id: 9, subject: "March offers & news" },
          { id: 12, subject: "June reminder" },
        ],
      }),
    );
    assertStringIncludes(html, "<summary>Load a template</summary>");
    assertStringIncludes(html, '<div class="prose"><ul>');
    assertStringIncludes(
      html,
      'href="/admin/emails?audience=active&amp;template=9">March offers &amp; news</a> (loaded)',
    );
    assertStringIncludes(
      html,
      '>March offers &amp; news</a> (loaded) <a class="danger small" href="/admin/emails/templates/9/delete">',
    );
    assert(!html.includes("June reminder</a> (loaded)"));
    assertStringIncludes(
      html,
      'href="/admin/emails?audience=active&amp;template=12">June reminder</a>',
    );
    assertStringIncludes(
      html,
      '<a class="danger small" href="/admin/emails/templates/9/delete">',
    );
    assertStringIncludes(html, 'name="template_id"');
    assertStringIncludes(
      html,
      '<option selected value="9">March offers &amp; news</option>',
    );
    assertStringIncludes(html, 'name="update_existing"');
    assertStringIncludes(
      html,
      '<fieldset class="checkboxes"><label><input name="update_existing"',
    );
    assertStringIncludes(html, '<div class="template-update-fields">');
    assertStringIncludes(
      html,
      'name="update_existing" type="checkbox" value="1"',
    );
    assert(!html.includes('checked name="update_existing"'));
  });

  test("shows the template controls with exactly one saved template", () => {
    const html = bulkEmailComposePage(
      OWNER_SESSION,
      composeState({
        selectedTemplateId: 9,
        templates: [{ id: 9, subject: "March offers & news" }],
      }),
    );
    assertStringIncludes(html, "<summary>Load a template</summary>");
    assertStringIncludes(
      html,
      '<fieldset class="checkboxes"><label><input name="update_existing"',
    );
    assertStringIncludes(html, '<div class="template-update-fields">');
    assertStringIncludes(html, 'name="template_id"');
  });

  test("keeps the submit button's two labelled spans", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());
    assertStringIncludes(
      html,
      '<span class="save-as-new">Save as new template</span>',
    );
    assertStringIncludes(
      html,
      '<span class="save-update">Update template</span>',
    );
  });

  test("omits the template controls when no templates exist", () => {
    const html = bulkEmailComposePage(OWNER_SESSION, composeState());
    assert(!html.includes("Load a template"));
    assert(!html.includes('name="template_id"'));
    assert(!html.includes('name="update_existing"'));
  });
});
