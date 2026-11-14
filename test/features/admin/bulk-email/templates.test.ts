import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";

import type { OwnerKeyEncrypted } from "#crypto/sealed.ts";
import {
  deleteEmailTemplate,
  getAllRawEmailTemplates,
  getRawEmailTemplate,
  insertEmailTemplate,
  updateEmailTemplate,
} from "#db/email-templates.ts";
import { emailTemplateRecord } from "#shared/records/email-templates.ts";
import {
  seedDraft,
  seedTemplate,
} from "#test/integration/server/bulk-email/helpers.ts";
import {
  expectHtmlResponse,
  expectIncludesAll,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { adminGet } from "#test-utils/session.ts";

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
      expectIncludesAll(html, ["Load a template", "My Newsletter"]);
    });

    test("?template=N pre-fills subject and body from the template", async () => {
      const id = await seedTemplate("Pre-fill Subject", "Pre-fill body");
      const html = await (
        await adminGet(`/admin/emails?audience=active&template=${id}`)
      ).text();
      expectIncludesAll(html, [
        "Pre-fill Subject",
        "Pre-fill body",
        // A template carries no marketing flag, so the box starts unticked
        // and the owner opts in deliberately.
        'name="marketing"',
      ]);
      assert(!html.includes('name="marketing" checked'));
      assert(!html.includes('checked name="marketing"'));
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
      expectIncludesAll(html, [
        "Template Subject",
        "Template body",
        // …but the marketing flag is carried over from the saved draft.
        'checked name="marketing" type="checkbox" value="1"',
      ]);
    });
  });

  describe("record declaration", () => {
    const input = { body: "<p>Body</p>", subject: "Welcome" };

    test("declares no collection read of its own", async () => {
      expect(await emailTemplateRecord.getAll()).toEqual([]);
    });

    test("logs the template by the subject the write saved", () => {
      expect(emailTemplateRecord.logName(input)).toBe("Welcome");
    });

    test("accepts every input its command writes", () => {
      expect(emailTemplateRecord.rule(input, null)).toEqual({
        ok: true,
        value: input,
      });
    });
  });
});
