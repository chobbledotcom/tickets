/** The values one field list builds, keyed by its columns, and the fields
 *  each writer cannot set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  byFieldKey,
  byFieldKind,
  closedFieldErrorOrNull,
  closedFields,
  type FieldKind,
  fieldOfKey,
} from "#shared/rest/field-specs.ts";

const FIELDS = [
  { key: "start_date", kind: "date" },
  { key: "name", kind: "name" },
  { feature: "logistics", key: "is_public", kind: "switch" },
  { key: "note", kind: "text", lockedFor: ["demo", "editor"] },
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
      recurringInterval: 3,
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

  test("a field closes for its feature turned off and for each writer it locks out", () => {
    const closedFor = (
      editor: boolean,
      demo: boolean,
      logistics: boolean,
    ): [string, string][] => [
      ...closedFields(FIELDS, {
        features: { builder: true, logistics, subscriptions: true },
        locks: { demo, editor },
      }),
    ];

    expect([
      closedFor(false, false, true),
      closedFor(false, false, false),
      closedFor(true, false, true),
      closedFor(false, true, true),
    ]).toEqual([
      [],
      [["is_public", "logistics"]],
      [["note", "editor"]],
      [["note", "demo"]],
    ]);
  });

  test("a supplied closed field is refused with its reason, and an open one passes", () => {
    const closed = new Map([
      ["assign_built_site", "builder"],
      ["webhook_url", "demo"],
      ["active", "editor"],
      ["uses_logistics", "logistics"],
    ] as const);
    const refusal = (key: string) => closedFieldErrorOrNull(closed, [key]);

    expect([
      refusal("assign_built_site"),
      refusal("webhook_url"),
      refusal("active"),
      refusal("uses_logistics"),
      refusal("name"),
      closedFieldErrorOrNull(closed, ["name", "active", "webhook_url"]),
    ]).toEqual([
      "assign_built_site needs site building turned on",
      "webhook_url cannot be set in the demo",
      "editors cannot set active",
      "uses_logistics needs logistics turned on",
      null,
      "editors cannot set active",
    ]);
  });

  test("fieldOfKey finds the declared field, and refuses a key it does not declare", () => {
    expect(fieldOfKey(FIELDS, "note")).toBe(FIELDS[3]);
    expect(() => fieldOfKey(FIELDS, "missing" as "note")).toThrow(
      "No declared field missing",
    );
  });
});
