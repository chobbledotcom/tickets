import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { decryptWithOwnerKey } from "#crypto/hybrid.ts";
import { getAllRawEmailTemplates } from "#db/email-templates.ts";
import { emailTemplateRecord } from "#shared/records/email-templates.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";
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

const createTemplate = async (subject: string, body: string) => {
  const created = await emailTemplateRecord.create({ body, subject });
  if (created.kind !== "written") throw new Error("create failed");
  return created.row;
};

describe("the email template record's declaration", () => {
  test("names a template on its pages and its delete page", () => {
    expect(emailTemplateRecord.activityName).toBe("Template");
    expect(deleteConfirmLabel(emailTemplateRecord)).toBe("Template subject");
  });
});

describeWithEnv("the email template record's commands", { db: true }, () => {
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
