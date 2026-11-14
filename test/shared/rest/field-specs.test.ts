/** The values one field list builds, keyed by its columns, and the fields
 *  each door reads. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  byFieldKey,
  byFieldKind,
  type FieldKind,
  fieldOfKey,
  fieldsOnDoor,
} from "#shared/rest/field-specs.ts";

const FIELDS = [
  { key: "start_date", kind: "date" },
  { key: "name", kind: "name" },
  { doors: ["api"], key: "is_public", kind: "switch" },
  { doors: ["form", "transfer"], key: "note", kind: "text" },
] as const;

describe("field specs", () => {
  test("byFieldKey keys each built value by its own column", () => {
    expect(byFieldKey(FIELDS, (field) => `${field.kind}:${field.key}`)).toEqual(
      {
        is_public: "switch:is_public",
        name: "name:name",
        note: "text:note",
        start_date: "date:start_date",
      },
    );
  });

  test("byFieldKind builds one value per field from its kind", () => {
    const lengths = {
      contactFields: 13,
      count: 5,
      date: 10,
      datetime: 8,
      dayPrices: 9,
      durationDays: 12,
      listingType: 11,
      name: 1,
      optionalDatetime: 16,
      price: 5,
      privateText: 11,
      switch: 0,
      text: 2,
      weekdays: 8,
    } as const satisfies Record<FieldKind, number>;
    expect(
      byFieldKind<typeof FIELDS, typeof lengths>(
        FIELDS,
        (field) => lengths[field.kind],
      ),
    ).toEqual({ is_public: 0, name: 1, note: 2, start_date: 10 });
  });

  test("each door reads the fields that name it, and every door reads a field that names none", () => {
    const keysOn = (door: "api" | "form" | "transfer") =>
      fieldsOnDoor(FIELDS, door).map((field) => field.key);

    expect([keysOn("api"), keysOn("form"), keysOn("transfer")]).toEqual([
      ["start_date", "name", "is_public"],
      ["start_date", "name", "note"],
      ["start_date", "name", "note"],
    ]);
  });

  test("fieldOfKey finds the declared field, and refuses a key it does not declare", () => {
    expect(fieldOfKey(FIELDS, "note")).toBe(FIELDS[3]);
    expect(() => fieldOfKey(FIELDS, "missing" as "note")).toThrow(
      "No declared field missing",
    );
  });
});
