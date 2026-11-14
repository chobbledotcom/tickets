import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { externalSourceRecord } from "#shared/records/external-sources.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withTestSession } from "#test-utils/session.ts";

const PATTERN = "https://dashboard.stripe.com/invoices/{external_id}";

const rule = (name: string, urlPattern: string) =>
  externalSourceRecord.rule({ name, urlPattern }, null);

describe("the external source rule", () => {
  test("trims the name and the URL pattern it stores", async () => {
    expect(await rule("  Stripe  ", `  ${PATTERN}  `)).toEqual({
      ok: true,
      value: { name: "Stripe", urlPattern: PATTERN },
    });
  });

  test("refuses an empty name before it reads the pattern", async () => {
    expect(await rule("   ", "")).toEqual({
      error: "name cannot be empty",
      ok: false,
    });
  });

  test("refuses an empty URL pattern", async () => {
    expect(await rule("Stripe", "  ")).toEqual({
      error: "url_pattern cannot be empty",
      ok: false,
    });
  });

  test("refuses a name past the text box limit", async () => {
    expect(await rule("n".repeat(251), PATTERN)).toEqual({
      error: "name must be 250 characters or fewer",
      ok: false,
    });
  });

  test("refuses a URL pattern past the text box limit", async () => {
    expect(await rule("Stripe", `https://${"u".repeat(243)}`)).toEqual({
      error: "url_pattern must be 250 characters or fewer",
      ok: false,
    });
  });

  test("accepts a name and a URL pattern at the limit", async () => {
    const name = "n".repeat(250);
    const urlPattern = `https://${"u".repeat(242)}`;

    expect(await rule(name, urlPattern)).toEqual({
      ok: true,
      value: { name, urlPattern },
    });
  });

  test("refuses a URL pattern that is not a web address", async () => {
    expect(await rule("Stripe", "ftp://files")).toEqual({
      error: "url_pattern must start with http:// or https://",
      ok: false,
    });
  });
});

describe("the external source record's declaration", () => {
  test("names a source on its pages", () => {
    expect(externalSourceRecord.activityName).toBe("Source");
  });
});

describeWithEnv("the external source record's commands", { db: true }, () => {
  test("creates a source, reads it back, and logs it", async () => {
    const created = await withTestSession(() =>
      externalSourceRecord.create({ name: "Stripe", urlPattern: PATTERN }),
    );

    expect(created).toMatchObject({
      kind: "written",
      row: { id: 1, name: "Stripe", url_pattern: PATTERN },
    });
    expect(await activityMessages()).toEqual(["Source 'Stripe' created"]);
  });

  test("deletes a source and logs it", async () => {
    await withTestSession(() =>
      externalSourceRecord.create({ name: "Old", urlPattern: PATTERN }),
    );

    expect(
      await withTestSession(() => externalSourceRecord.remove(1)),
    ).toEqual({ kind: "deleted" });
    expect(
      await withTestSession(async () => [
        await externalSourceRecord.load(1),
        await externalSourceRecord.getAll(),
      ]),
    ).toEqual([null, []]);
    expect((await activityMessages())[0]).toBe("Source 'Old' deleted");
  });
});
