/**
 * Bulk-email template saves and deletes: the routes in
 * bulk-email-templates.ts.
 */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
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
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

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
    const { response } = await adminFormPost("/admin/emails/templates", {
      audience: "active",
      body: "Body",
      subject: "Subject",
    });
    expectFlash(
      response,
      `You've reached the limit of ${MAX_EMAIL_TEMPLATES} saved templates.`,
      false,
    );
  });

  test("POST /admin/emails/templates saves a new template and redirects", async () => {
    const { response } = await adminFormPost("/admin/emails/templates", {
      audience: "active",
      body: "Template body",
      subject: "Template subject",
    });
    const redirectUrl = expectRedirect(response);
    assertStringIncludes(redirectUrl, "template=");
    expectFlash(response, "Template saved.");
  });

  test("POST /admin/emails/templates rejects an empty subject", async () => {
    const { response } = await adminFormPost("/admin/emails/templates", {
      audience: "active",
      body: "Template body",
      subject: "",
    });
    expectFlash(response, "Subject is required", false);
  });

  test("POST /admin/emails/templates updates an existing template", async () => {
    const id = await seedTemplate("Old subject", "Old body");
    const { response } = await adminFormPost("/admin/emails/templates", {
      audience: "active",
      body: "Updated body",
      subject: "Updated subject",
      template_id: String(id),
      update_existing: "1",
    });
    const redirectUrl = expectRedirect(response);
    assertStringIncludes(redirectUrl, `template=${id}`);
    expectFlash(response, "Template updated.");
  });

  test("POST /admin/emails/templates update returns 404 for missing template", async () => {
    const { response } = await adminFormPost("/admin/emails/templates", {
      audience: "active",
      body: "Body",
      subject: "Subject",
      template_id: "9999",
      update_existing: "1",
    });
    expectFlash(response, "That template no longer exists.", false);
  });

  test("GET /admin/emails/templates/:id/delete shows the confirmation page with the decrypted subject", async () => {
    const id = await seedTemplate("To delete", "Body");
    const response = await adminGet(`/admin/emails/templates/${id}/delete`);
    const html = await expectHtmlResponse(response, 200);
    expectIncludesAll(html, [
      "Delete template",
      // The subject (encrypted at rest) is decrypted to confirm against.
      "To delete",
      'name="confirm_identifier"',
      `action="/admin/emails/templates/${id}/delete"`,
    ]);
  });

  test("GET /admin/emails/templates/:id/delete 404s for unknown template", async () => {
    const response = await adminGet("/admin/emails/templates/9999/delete");
    expect(response.status).toBe(404);
  });

  test("POST /admin/emails/templates/:id/delete removes the template when the subject matches", async () => {
    const id = await seedTemplate("To delete", "Body");
    const { response } = await adminFormPost(
      `/admin/emails/templates/${id}/delete`,
      { confirm_identifier: "To delete" },
    );
    await expectFlashRedirect(
      "/admin/emails?audience=active",
      "Template deleted.",
    )(response);
  });

  test("POST /admin/emails/templates/:id/delete rejects a mismatched subject", async () => {
    const id = await seedTemplate("To delete", "Body");
    const { response } = await adminFormPost(
      `/admin/emails/templates/${id}/delete`,
      { confirm_identifier: "Wrong subject" },
    );
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

  test("POST /admin/emails/templates/:id/delete 404s for unknown template", async () => {
    const { response } = await adminFormPost(
      "/admin/emails/templates/9999/delete",
      { confirm_identifier: "anything" },
    );
    expect(response.status).toBe(404);
  });
});
