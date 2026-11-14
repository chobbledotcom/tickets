import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attributeOptionsTable } from "#db/attributes.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttributeWithOptions } from "#test-utils/db-helpers/attributes.ts";
import { deleteConfirmLabel } from "#test-utils/record-labels.ts";

describe("the attribute record's declaration", () => {
  test("names an attribute on its pages and its delete page", () => {
    expect(attributeRecord.activityName).toBe("Attribute");
    expect(deleteConfirmLabel(attributeRecord)).toBe("Attribute name");
  });
});

describeWithEnv("the attribute record's commands", { db: true }, () => {
  test("creates attributes in the order they were made and logs each", async () => {
    await attributeRecord.create({ name: "Size" });
    await attributeRecord.create({ name: "Colour" });

    expect(
      (await attributeRecord.getAll()).map(({ name, options }) => ({
        name,
        options,
      })),
    ).toEqual([
      { name: "Size", options: [] },
      { name: "Colour", options: [] },
    ]);
    expect(await activityMessages()).toEqual([
      "Attribute 'Colour' created",
      "Attribute 'Size' created",
    ]);
  });

  test("deletes an attribute with its options and logs it", async () => {
    const attribute = await createTestAttributeWithOptions("Size", ["S", "M"]);

    expect(await attributeRecord.remove(attribute.id)).toEqual({
      kind: "deleted",
    });
    expect([
      await attributeRecord.load(attribute.id),
      await attributeOptionsTable.read.many({}),
    ]).toEqual([null, []]);
    expect(await activityMessages()).toEqual(["Attribute 'Size' deleted"]);
  });
});
