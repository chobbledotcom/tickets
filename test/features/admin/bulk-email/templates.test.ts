import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { encryptWithOwnerKey } from "#crypto/keys.ts";
import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import { getDb } from "#db/client.ts";
import {
  deleteEmailTemplate,
  getAllRawEmailTemplates,
  getRawEmailTemplate,
  insertEmailTemplate,
  updateEmailTemplate,
} from "#db/email-templates.ts";
import { settings } from "#db/settings.ts";
import { MAX_EMAIL_TEMPLATES } from "#shared/limits.ts";
import { seedDraft } from "#test/integration/server/bulk-email/helpers.ts";
import {
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

const seedTemplate = async (subject: string, body: string) => {
  const encSubject = await encryptWithOwnerKey(subject, settings.publicKey);
  const encBody = await encryptWithOwnerKey(body, settings.publicKey);
  return insertEmailTemplate(encSubject, encBody);
};

/** Hand-crafted stand-in for an owner-key-encrypted stored value — the raw
 * storage round-trips it opaquely, so a plain marker string suffices (test
 * fixture cast). */
const fakeSealed = (v: string): OwnerKeyEncrypted => v as OwnerKeyEncrypted;

describeWithEnv("server bulk email > templates", { db: true }, () => {
  describe("raw template storage", () => {
    // The module stores opaque sealed TEXT (the routes encrypt before
    // writing), so these direct tests can round-trip fixture strings.
    test("insert then getRawEmailTemplate returns the stored row", async () => {
      const id = await insertEmailTemplate(
        fakeSealed("enc-subject"),
        fakeSealed("enc-body"),
      );
      expect(await getRawEmailTemplate(id)).toEqual({
        body: "enc-body",
        id,
        subject: "enc-subject",
      });
    });

    test("getRawEmailTemplate returns null for an unknown id", async () => {
      expect(await getRawEmailTemplate(9999)).toBeNull();
    });

    test("updateEmailTemplate persists the new subject and body for that row only", async () => {
      const edited = await insertEmailTemplate(
        fakeSealed("old-subject"),
        fakeSealed("old-body"),
      );
      const untouched = await insertEmailTemplate(
        fakeSealed("keep-subject"),
        fakeSealed("keep-body"),
      );

      await updateEmailTemplate(
        edited,
        fakeSealed("new-subject"),
        fakeSealed("new-body"),
      );

      expect(await getRawEmailTemplate(edited)).toEqual({
        body: "new-body",
        id: edited,
        subject: "new-subject",
      });
      expect(await getRawEmailTemplate(untouched)).toEqual({
        body: "keep-body",
        id: untouched,
        subject: "keep-subject",
      });
    });

    test("deleteEmailTemplate removes the row", async () => {
      const doomed = await insertEmailTemplate(
        fakeSealed("bye-subject"),
        fakeSealed("bye-body"),
      );
      const kept = await insertEmailTemplate(
        fakeSealed("stay-subject"),
        fakeSealed("stay-body"),
      );

      await deleteEmailTemplate(doomed);

      expect(await getRawEmailTemplate(doomed)).toBeNull();
      expect((await getRawEmailTemplate(kept))?.subject).toBe("stay-subject");
    });

    test("getAllRawEmailTemplates lists every template newest-first", async () => {
      const first = await insertEmailTemplate(
        fakeSealed("first-subject"),
        fakeSealed("first-body"),
      );
      const second = await insertEmailTemplate(
        fakeSealed("second-subject"),
        fakeSealed("second-body"),
      );
      expect(
        (await getAllRawEmailTemplates()).map((template) => template.id),
      ).toEqual([second, first]);
    });
  });

  describe("email templates", () => {
    test("compose page lists saved templates", async () => {
      await seedTemplate("My Newsletter", "Hello everyone");
      const html = await (
        await adminGet("/admin/emails?audience=active")
      ).text();
      expect(html).toContain("Load a template");
      expect(html).toContain("My Newsletter");
    });

    test("?template=N pre-fills subject and body from the template", async () => {
      const id = await seedTemplate("Pre-fill Subject", "Pre-fill body");
      const html = await (
        await adminGet(`/admin/emails?audience=active&template=${id}`)
      ).text();
      expect(html).toContain("Pre-fill Subject");
      expect(html).toContain("Pre-fill body");
    });

    test("?template=N for an unknown id still renders the compose page", async () => {
      expectHtmlResponse(
        await adminGet("/admin/emails?audience=active&template=9999"),
        200,
      );
    });

    test("?template=N keeps the saved draft's marketing flag while overriding subject and body", async () => {
      const id = await seedTemplate("Template Subject", "Template body");
      await seedDraft({
        body: "Draft body",
        marketing: true,
        subject: "Draft subject",
        target: { audience: "active", kind: "audience" },
      });
      const html = await (
        await adminGet(`/admin/emails?audience=active&template=${id}`)
      ).text();
      // The template's content replaces the draft's…
      expect(html).toContain("Template Subject");
      expect(html).toContain("Template body");
      // …but the marketing flag is carried over from the saved draft.
      expect(html).toContain(
        'checked name="marketing" type="checkbox" value="1"',
      );
    });

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
      expect(redirectUrl).toContain("template=");
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
      expect(redirectUrl).toContain(`template=${id}`);
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
      expect(html).toContain("Delete template");
      // The subject (encrypted at rest) is decrypted to confirm against.
      expect(html).toContain("To delete");
      expect(html).toContain('name="confirm_identifier"');
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
    });

    test("POST /admin/emails/templates/:id/delete 404s for unknown template", async () => {
      const { response } = await adminFormPost(
        "/admin/emails/templates/9999/delete",
        { confirm_identifier: "anything" },
      );
      expect(response.status).toBe(404);
    });
  });
});
