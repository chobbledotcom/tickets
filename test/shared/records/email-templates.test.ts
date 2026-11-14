import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import { execute } from "#db/client.ts";
import { getAllRawEmailTemplates } from "#db/email-templates.ts";
import { emailTemplateRecord } from "#shared/records/email-templates.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { writtenRow } from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";
import { withTestSession } from "#test-utils/session.ts";

/** Every stored template, decrypted the way the owner reads it. */
const storedTemplates = () =>
  withTestSession(async () => {
    const key = await requireRequestPrivateKey();
    const rows = (await getAllRawEmailTemplates()).toSorted(
      (first, second) => first.id - second.id,
    );
    return Promise.all(
      rows.map(async (row) => ({
        body: await decryptWithOwnerKey(row.body, key),
        id: row.id,
        subject: await decryptWithOwnerKey(row.subject, key),
      })),
    );
  });

const createTemplate = (subject: string, body: string) =>
  writtenRow(emailTemplateRecord.create({ body, subject }));

describeRecord(emailTemplateRecord, "Template", "Template subject", () => {
  test("lists no templates through the record", async () => {
    await createTemplate("Hello", "Body");

    expect(await emailTemplateRecord.getAll()).toEqual([]);
  });

  test("creates a sealed template and answers its subject", async () => {
    expect(await createTemplate("Hello", "Welcome aboard")).toEqual({
      id: 1,
      subject: "Hello",
    });
    expect(await storedTemplates()).toEqual([
      { body: "Welcome aboard", id: 1, subject: "Hello" },
    ]);
  });

  test("updates the template it names in place", async () => {
    await createTemplate("Keep", "Kept body");
    const second = await createTemplate("Old", "Old body");

    expect(
      await emailTemplateRecord.update(second.id, {
        body: "New body",
        subject: "New",
      }),
    ).toEqual({ kind: "written", row: { id: second.id, subject: "New" } });
    expect(await storedTemplates()).toEqual([
      { body: "Kept body", id: 1, subject: "Keep" },
      { body: "New body", id: second.id, subject: "New" },
    ]);
  });

  test("updates a template stored under id 0 in place", async () => {
    await createTemplate("Old", "Old body");
    await execute("UPDATE email_templates SET id = 0 WHERE id = 1");

    expect(
      await emailTemplateRecord.update(0, {
        body: "New body",
        subject: "New",
      }),
    ).toEqual({ kind: "written", row: { id: 0, subject: "New" } });
    expect(await storedTemplates()).toEqual([
      { body: "New body", id: 0, subject: "New" },
    ]);
  });

  test("answers not-found for an update of a missing template", async () => {
    expect(
      await emailTemplateRecord.update(99, { body: "B", subject: "S" }),
    ).toEqual({ kind: "not-found" });
    expect(await storedTemplates()).toEqual([]);
  });

  test("loads a template's subject for its delete page", async () => {
    const template = await createTemplate("Weekly news", "Body");

    expect(
      await withTestSession(() => emailTemplateRecord.load(template.id)),
    ).toEqual({ id: template.id, subject: "Weekly news" });
    expect(await withTestSession(() => emailTemplateRecord.load(99))).toBe(
      null,
    );
  });

  test("names a template by its subject", () => {
    expect(emailTemplateRecord.nameOf({ id: 1, subject: "Weekly" })).toBe(
      "Weekly",
    );
    expect(emailTemplateRecord.logName({ body: "B", subject: "Monthly" })).toBe(
      "Monthly",
    );
  });

  test("deletes a template it holds and answers not-found after", async () => {
    const template = await createTemplate("Gone soon", "Body");

    expect(await emailTemplateRecord.remove(template.id)).toEqual({
      kind: "deleted",
    });
    expect(await storedTemplates()).toEqual([]);
    expect(await emailTemplateRecord.remove(template.id)).toEqual({
      kind: "not-found",
    });
  });
});
