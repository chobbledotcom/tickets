// Render pins for the bulk-email preview page. The page used to have only
// DB-backed HTTP coverage, so a whole-file mutation run left its labels,
// ternaries, and attribute strings unpinned (issue #2370).

import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type BulkEmailPreviewState,
  bulkEmailPreviewPage,
} from "#templates/admin/bulk-email.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const AUDIENCE_TARGET = { audience: "active", kind: "audience" } as const;

const previewState = (
  overrides: Partial<BulkEmailPreviewState> = {},
): BulkEmailPreviewState => ({
  audienceDescription:
    "Everyone booked onto a listing that is currently active.",
  canBulkSend: true,
  contactSummary: "",
  disabledReason: "",
  draft: {
    body: "Hello **world**",
    marketing: false,
    subject: "Spring sale",
    target: AUDIENCE_TARGET,
  },
  mailtoLink: "mailto:?bcc=ada@example.com",
  providerLabel: "Resend",
  recipientCount: 2,
  sendableCount: 2,
  sendableEmails: ["ada@example.com", "grace@example.com"],
  skippedCount: 0,
  targetLabel: "Active listing attendees",
  ...overrides,
});

describe("bulkEmailPreviewPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the title, edit link, and To line", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());

    assertStringIncludes(html, "<h1>Preview bulk email</h1>");
    assertStringIncludes(html, 'href="/admin/emails?audience=active"');
    assertStringIncludes(html, "Edit message");
    assertStringIncludes(
      html,
      '<div class="prose"><p><strong>To:</strong> Active listing attendees (2 recipients)',
    );
    assertStringIncludes(html, "<strong>Subject:</strong> Spring sale");
    assertStringIncludes(
      html,
      '<div class="prose"><h2>Message preview</h2></div>',
    );
    assertStringIncludes(
      html,
      '<div class="prose"><h2>Send through your email provider</h2></div>',
    );
    assertStringIncludes(
      html,
      '<div class="prose"><h2>Or send from your own email app</h2>',
    );
  });

  test("renders a single recipient in the To line and manual section", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({
        recipientCount: 1,
        sendableCount: 1,
        sendableEmails: ["ada@example.com"],
      }),
    );
    assertStringIncludes(html, "(1 recipient)");
    assertStringIncludes(
      html,
      "This opens your email app with the message addressed straight to your one recipient. It needs no provider setup",
    );
    assertStringIncludes(html, "Open a draft to 1 recipient</a>");
  });

  test("renders the BCC copy and warning with the separating space", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(
      html,
      "This opens your email app with everyone in BCC. It needs no provider setup",
    );
  });

  test("reports how many unsubscribed people are skipped", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({ skippedCount: 1 }),
    );
    assertStringIncludes(
      html,
      "(2 recipients, 1 unsubscribed will be skipped)",
    );
  });

  test("shows the audience description and contact summary when present", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({
        contactSummary: "Most of these people have not booked in 6 months.",
      }),
    );
    assertStringIncludes(
      html,
      '<p class="small">Everyone booked onto a listing that is currently active.</p>',
    );
    assertStringIncludes(
      html,
      '<p class="small">Most of these people have not booked in 6 months.</p>',
    );
  });

  test("omits the small paragraphs when both are empty", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({ audienceDescription: undefined, contactSummary: "" }),
    );
    assert(!html.includes('class="small"'));
  });

  test("renders the message preview as markdown", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(html, "<h2>Message preview</h2>");
    assertStringIncludes(
      html,
      '<article class="prose email-preview"><p>Hello <strong>world</strong></p>',
    );
  });

  test("explains marketing email and adds the unsubscribe footer", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({
        draft: {
          body: "Hello **world**",
          marketing: true,
          subject: "Spring sale",
          target: AUDIENCE_TARGET,
        },
      }),
    );
    assertStringIncludes(html, "<strong>Marketing email.</strong>");
    assertStringIncludes(
      html,
      '<div class="prose"><p class="small">A personalized unsubscribe footer is appended to each marketing email.</p></div>',
    );
  });

  test("explains transactional email without the footer notice", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(
      html,
      "<strong>Transactional / service email.</strong>",
    );
    assert(!html.includes("A personalized unsubscribe footer is appended"));
  });

  test("renders the send form with the provider name when available", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(html, 'action="/admin/emails/send"');
    assertStringIncludes(html, 'id="bulk-email-send"');
    assertStringIncludes(html, 'class="inline"');
    assertStringIncludes(html, "Send to 2 recipients via Resend");
  });

  test("renders the disabled notice when no provider can send", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({
        canBulkSend: false,
        disabledReason: "No bulk provider is configured.",
      }),
    );
    assertStringIncludes(
      html,
      "<strong>Sending is disabled.</strong> No bulk provider is configured.",
    );
    assertStringIncludes(html, '<span class="btn btn--disabled">');
    assertStringIncludes(html, "Send to 2 recipients</span>");
    assertStringIncludes(
      html,
      "Set up your email provider in advanced settings",
    );
    assert(!html.includes('id="bulk-email-send"'));
  });

  test("renders the manual-send section with the BCC mailto link", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(html, "<h2>Or send from your own email app</h2>");
    assertStringIncludes(html, 'href="mailto:?bcc=ada@example.com"');
    assertStringIncludes(html, "Open a BCC draft to 2 recipients</a>");
  });

  test("lists the recipient addresses for copying when there are any", () => {
    const html = bulkEmailPreviewPage(OWNER_SESSION, previewState());
    assertStringIncludes(
      html,
      '<div class="prose"><h2>Copy the address list</h2>',
    );
    assertStringIncludes(
      html,
      '<textarea class="recipient-emails" readonly>ada@example.com, grace@example.com</textarea>',
    );
  });

  test("lists the copy block for a single sendable address", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({
        recipientCount: 1,
        sendableCount: 1,
        sendableEmails: ["ada@example.com"],
      }),
    );
    assertStringIncludes(html, "<h2>Copy the address list</h2>");
    assertStringIncludes(
      html,
      '<textarea class="recipient-emails" readonly>ada@example.com</textarea>',
    );
  });

  test("hides the copy-addresses block when no addresses are sendable", () => {
    const html = bulkEmailPreviewPage(
      OWNER_SESSION,
      previewState({ sendableEmails: [] }),
    );
    assert(!html.includes("Copy the address list"));
  });
});
