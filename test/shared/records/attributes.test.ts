import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { attributeOptionsTable } from "#db/attributes.ts";
import { attributeRecord } from "#shared/records/attributes.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import { createTestAttributeWithOptions } from "#test-utils/db-helpers/attributes.ts";
import { expectRecordDelete } from "#test-utils/record-commands.ts";
import { describeRecord } from "#test-utils/record-labels.ts";

describeRecord(attributeRecord, "Attribute", "Attribute name", () => {
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

    await expectRecordDelete(attributeRecord, attribute.id, [
      "Attribute 'Size' deleted",
    ]);
    expect(await attributeOptionsTable.read.many({})).toEqual([]);
  });
});
