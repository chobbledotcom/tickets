/**
 * Bulk-email template saves and deletes: the routes in
 * bulk-email-templates.ts.
 */

import { assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
import { seedTemplate } from "#test/integration/server/bulk-email/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectIncludesAll,
  expectRedirect,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { TestFormValues } from "#test-utils/form-values.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const TEMPLATES_PATH = "/admin/emails/templates";

/** Posts the save form with the fields every save sends, plus `fields`. */
const postTemplate = async (fields: TestFormValues): Promise<Response> =>
  (
    await adminFormPost(TEMPLATES_PATH, {
      audience: "active",
      body: "Body",
      subject: "Subject",
      ...fields,
    })
  ).response;

/** Seeds a template with the subject "To delete", then posts the delete form
 * with `typed` as the confirmation. */
const postDeleteConfirm = async (
  typed: string,
): Promise<{ id: number; response: Response }> => {
  const id = await seedTemplate("To delete", "Body");
  const { response } = await adminFormPost(`${TEMPLATES_PATH}/${id}/delete`, {
    confirm_identifier: typed,
  });
  return { id, response };
};

const refusedSaves: {
  name: string;
  fields: TestFormValues;
  message: string;
}[] = [
  {
    fields: { body: "Template body", subject: "" },
    message: "Subject is required",
    name: "rejects an empty subject",
  },
  {
    fields: { template_id: "9999", update_existing: "1" },
    message: "That template no longer exists.",
    name: "update returns 404 for missing template",
  },
];

const unknownTemplateRequests: {
  name: string;
  send: () => Promise<Response>;
}[] = [
  {
    name: "GET /admin/emails/templates/:id/delete 404s for unknown template",
    send: () => adminGet(`${TEMPLATES_PATH}/9999/delete`),
  },
  {
    name: "POST /admin/emails/templates/:id/delete 404s for unknown template",
    send: async () =>
      (
        await adminFormPost(`${TEMPLATES_PATH}/9999/delete`, {
          confirm_identifier: "anything",
        })
      ).response,
  },
];

describeWithEnv("bulk email templates", { db: true }, () => {
  test("POST /admin/emails/templates refuses to save when the template limit is reached", async () => {
    // Fill the table to the cap in one statement. The limit check only counts
    // rows, so the (opaque) content here need not be real encrypted blobs.
    const rows = Array.from(
      { length: MAX_EMAIL_TEMPLATES },
      () => "('x', 'y')",
    ).join(", ");
    await getDb().execute(
      `INSERT INTO email_templates (subject, body) VALUES ${rows}`,
    );
    expectFlash(
      await postTemplate({}),
      `You've reached the limit of ${MAX_EMAIL_TEMPLATES} saved templates.`,
      false,
    );
  });

  test("POST /admin/emails/templates saves a new template and redirects", async () => {
    const response = await postTemplate({
      body: "Template body",
      subject: "Template subject",
    });
    assertStringIncludes(expectRedirect(response), "template=");
    expectFlash(response, "Template saved.");
  });

  for (const { name, fields, message } of refusedSaves) {
    test(`POST /admin/emails/templates ${name}`, async () => {
      expectFlash(await postTemplate(fields), message, false);
    });
  }

  test("POST /admin/emails/templates updates an existing template", async () => {
    const id = await seedTemplate("Old subject", "Old body");
    const response = await postTemplate({
      body: "Updated body",
      subject: "Updated subject",
      template_id: String(id),
      update_existing: "1",
    });
    assertStringIncludes(expectRedirect(response), `template=${id}`);
    expectFlash(response, "Template updated.");
  });

  test("GET /admin/emails/templates/:id/delete shows the confirmation page with the decrypted subject", async () => {
    const id = await seedTemplate("To delete", "Body");
    const response = await adminGet(`${TEMPLATES_PATH}/${id}/delete`);
    const html = await expectHtmlResponse(response, 200);
    expectIncludesAll(html, [
      "Delete template",
      // The subject (encrypted at rest) is decrypted to confirm against.
      "To delete",
      'name="confirm_identifier"',
      `action="/admin/emails/templates/${id}/delete"`,
    ]);
  });

  for (const { name, send } of unknownTemplateRequests) {
    test(name, async () => {
      expectStatus(404)(await send());
    });
  }

  test("POST /admin/emails/templates/:id/delete removes the template when the subject matches", async () => {
    const { response } = await postDeleteConfirm("To delete");
    await expectFlashRedirect(
      "/admin/emails?audience=active",
      "Template deleted.",
    )(response);
  });

  test("POST /admin/emails/templates/:id/delete rejects a mismatched subject", async () => {
    const { id, response } = await postDeleteConfirm("Wrong subject");
    expectFlash(
      response,
      "Template subject does not match. Please type the exact template subject to confirm deletion.",
      false,
    );
    // The owner lands back on the confirmation page to try again.
    assertStringIncludes(
      response.headers.get("location") ?? "",
      `/admin/emails/templates/${id}/delete?`,
    );
  });
});
