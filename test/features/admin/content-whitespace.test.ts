// A Markdown box stores the indentation of its text, because four spaces
// start a code block. Every surface that writes Markdown keeps it. Each test
// posts the same indented code block through one surface, then reads the
// stored value.

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { base64ToBase64Url } from "#crypto/utils.ts";
import { getContactRecord, hashEmail } from "#db/contact-preferences.ts";
import { getGroupsById } from "#db/groups.ts";
import { getNewsPostSummaries } from "#db/news-posts.ts";
import { getNotesFor } from "#db/notes/queries.ts";
import { noteTargets } from "#db/notes/target.ts";
import { getAllQuestionsWithAnswers } from "#db/questions/queries.ts";
import { records } from "#db/record-table.ts";
import { settings } from "#db/settings.ts";
import { renderMarkdown } from "#shared/markdown.ts";
import { requireValue } from "#shared/required-value.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { describeWithRecordFeatures as describeWithEnv } from "#test-utils/feature-suites.ts";
import {
  expectFormStoresMarkdown,
  MARKDOWN_BOX,
  MARKDOWN_CODE,
} from "#test-utils/markdown-writes.ts";
import { adminFormPost, adminGet, apiRequest } from "#test-utils/session.ts";
import { createOwing } from "./invoice-helpers.ts";
import { findPage } from "./site-pages/helpers.ts";

/** The group with this name, read from the stored rows. */
const groupNamed = async (name: string) =>
  requireValue(
    [...(await getGroupsById()).values()].find((row) => row.name === name),
    `No group named ${name}`,
  );

/** The news post with this name, read from the stored rows. */
const newsPostNamed = async (name: string) =>
  requireValue(
    await records.news_posts.find(
      requireValue(
        (await getNewsPostSummaries()).find((row) => row.name === name),
        `No news post named ${name}`,
      ).id,
    ),
    `No news post row named ${name}`,
  );

/** The settings boxes that hold Markdown: the label a person reads, the page
 *  that saves the box, the box name in the form, and the stored value. */
const SETTINGS_TEXTS = [
  [
    "contact page text",
    "/admin/site/contact",
    "contactPageText",
    "contactPageText",
  ],
  ["order intro", "/admin/site/order", "orderIntroText", "orderIntroText"],
  ["terms", "/admin/settings/terms", "termsAndConditions", "terms"],
  ["site footer", "/admin/settings/site-footer", "siteFooter", "siteFooter"],
] as const;

describeWithEnv("Markdown content whitespace", { db: true }, () => {
  for (const [label, path, field, setting] of SETTINGS_TEXTS) {
    test(`the ${label} setting keeps the indentation of a code block`, () =>
      expectFormStoresMarkdown(
        path,
        { [field]: MARKDOWN_BOX },
        () => settings[setting],
      ));
  }

  test("the home page text setting keeps the indentation of a code block", async () => {
    await expectFormStoresMarkdown(
      "/admin/site",
      { homepageText: MARKDOWN_BOX, websiteTitle: "My Site" },
      () => settings.homepageText,
    );
  });

  test("the page form keeps the indentation of a code block", async () => {
    await adminFormPost("/admin/site/pages", {
      content: MARKDOWN_BOX,
      name: "Code page",
      slug: "code-form",
    });
    const page = await findPage("code-form");
    expect(page.content).toBe(MARKDOWN_CODE);
    expect(renderMarkdown(page.content, new Map())).toContain("<pre><code>");
  });

  test("the page API keeps the indentation of a code block", async () => {
    const created = await assertJson<{ page: { content: string } }>(
      apiRequest("/api/admin/site-pages", {
        body: { content: MARKDOWN_BOX, name: "Code page", slug: "code-api" },
        method: "POST",
      }),
      201,
    );
    expect(created.page.content).toBe(MARKDOWN_CODE);
  });

  test("the news form keeps the indentation of a code block", async () => {
    await expectFormStoresMarkdown(
      "/admin/site/news",
      {
        content: MARKDOWN_BOX,
        metaDescription: "",
        metaTitle: "",
        name: "Code news",
        snippet: "Short",
      },
      async () => (await newsPostNamed("Code news")).content,
    );
  });

  test("the group form keeps the indentation of a code block", async () => {
    await adminFormPost("/admin/groups", {
      description: MARKDOWN_BOX,
      maxAttendees: "0",
      name: "Code group",
      termsAndConditions: MARKDOWN_BOX,
    });
    const group = await groupNamed("Code group");
    expect([group.description, group.termsAndConditions]).toEqual([
      MARKDOWN_CODE,
      MARKDOWN_CODE,
    ]);
  });

  test("the group API keeps the indentation of a code block", async () => {
    const created = await assertJson<{ group: { id: number } }>(
      apiRequest("/api/admin/groups", {
        body: {
          description: "Group",
          name: "Code API group",
          terms_and_conditions: "Terms",
        },
        method: "POST",
      }),
      201,
    );
    await assertJson(
      apiRequest(`/api/admin/groups/${created.group.id}`, {
        body: {
          description: MARKDOWN_BOX,
          terms_and_conditions: MARKDOWN_BOX,
        },
        method: "PUT",
      }),
      200,
    );
    const group = await groupNamed("Code API group");
    expect([group.description, group.termsAndConditions]).toEqual([
      MARKDOWN_CODE,
      MARKDOWN_CODE,
    ]);
  });

  test("the question form keeps the indentation of a code block", async () => {
    await expectFormStoresMarkdown(
      "/admin/questions",
      { displayType: "radio", text: MARKDOWN_BOX },
      async () =>
        requireValue(
          (await getAllQuestionsWithAnswers())[0],
          "the question form stores no question",
        ).text,
    );
  });

  test("the question API keeps the indentation of a code block", async () => {
    const created = await assertJson<{ question: { id: number } }>(
      apiRequest("/api/admin/questions", {
        body: { display_type: "radio", text: "Question" },
        method: "POST",
      }),
      201,
    );
    const updated = await assertJson<{ question: { text: string } }>(
      apiRequest(`/api/admin/questions/${created.question.id}`, {
        body: { text: `\n${MARKDOWN_BOX}` },
        method: "PUT",
      }),
      200,
    );
    expect(updated.question.text).toBe(MARKDOWN_CODE);
  });

  test("a record note keeps the indentation of a code block", async () => {
    const { id } = await createTestGroup({ name: "Noted group" });
    await adminFormPost(`/admin/groups/${id}/note`, { note: MARKDOWN_BOX });
    const notes = await getNotesFor(
      noteTargets.of("group")(id),
      await getTestPrivateKey(),
    );
    expect(notes.map((row) => row.note)).toEqual([MARKDOWN_CODE]);
  });

  test("a contact record note keeps the indentation of a code block", async () => {
    const hash = await hashEmail("indented@example.com");
    await adminFormPost(`/admin/history/${base64ToBase64Url(hash)}`, {
      adminNotes: MARKDOWN_BOX,
    });
    const record = await getContactRecord(hash, await getTestPrivateKey());
    expect(record.adminNotes).toBe(MARKDOWN_CODE);
  });

  test("the invoice text keeps the indentation of a code block", async () => {
    const attendeeId = await createOwing(1500);
    await adminFormPost("/admin/invoices/new", {
      attendeeId: String(attendeeId),
      body: MARKDOWN_BOX,
      number: "1",
    });
    expect(settings.invoiceBodyTemplate).toBe(MARKDOWN_CODE);
  });

  test("the bulk email body keeps the indentation of a code block", async () => {
    await adminFormPost("/admin/emails/preview", {
      audience: "active",
      body: MARKDOWN_BOX,
      subject: "News",
    });
    const html = await (await adminGet("/admin/emails/preview")).text();
    expect(html).toContain("<pre><code>const value = 7;");
  });

  test("a box with only spaces stores no text", async () => {
    await adminFormPost("/admin/site/pages", {
      content: "   \n  ",
      name: "Blank page",
      slug: "blank-form",
    });
    expect((await findPage("blank-form")).content).toBe("");
  });
});
