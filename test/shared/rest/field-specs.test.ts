/** The values one field list builds, keyed by its columns, and the fields
 *  each writer cannot set. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  byFieldKey,
  closedFieldErrorOrNull,
  closedFields,
  featureClosedKeys,
  fieldOfKey,
} from "#shared/rest/field-specs.ts";

const FIELDS = [
  { key: "startDate", kind: "date" },
  { key: "name", kind: "name" },
  { feature: "logistics", key: "isPublic", kind: "switch" },
  { key: "note", kind: "text", lockedFor: ["demo", "editor"] },
] as const;

describe("field specs", () => {
  test("byFieldKey keys each built value by its own column", () => {
    expect(byFieldKey(FIELDS, (field) => `${field.kind}:${field.key}`)).toEqual(
      {
        isPublic: "switch:isPublic",
        name: "name:name",
        note: "text:note",
        startDate: "date:startDate",
      },
    );
  });

  test("a field closes for its feature turned off and for each writer it locks out", () => {
    const closedFor = (
      editor: boolean,
      demo: boolean,
      logistics: boolean,
    ): [string, string][] => [
      ...closedFields(FIELDS, {
        features: {
          attributes: true,
          builder: true,
          logistics,
          subscriptions: true,
        },
        locks: { demo, editor, nonOwner: false },
      }),
    ];

    expect([
      closedFor(false, false, true),
      closedFor(false, false, false),
      closedFor(true, false, true),
      closedFor(false, true, true),
    ]).toEqual([
      [],
      [["isPublic", "logistics"]],
      [["note", "editor"]],
      [["note", "demo"]],
    ]);
  });

  test("a supplied closed field is refused with its reason, and an open one passes", () => {
    const closed = new Map([
      ["assignBuiltSite", "builder"],
      ["webhookUrl", "demo"],
      ["active", "editor"],
      ["usesLogistics", "logistics"],
      ["recurringPrice", "subscriptions"],
    ] as const);
    const refusal = (key: string) => closedFieldErrorOrNull(closed, [key]);

    expect([
      refusal("assignBuiltSite"),
      refusal("webhookUrl"),
      refusal("active"),
      refusal("usesLogistics"),
      refusal("recurringPrice"),
      refusal("name"),
      closedFieldErrorOrNull(closed, ["name", "active", "webhookUrl"]),
    ]).toEqual([
      "assignBuiltSite needs site building turned on",
      "webhookUrl cannot be set in the demo",
      "editors cannot set active",
      "usesLogistics needs logistics turned on",
      "recurringPrice needs subscriptions turned on",
      null,
      "editors cannot set active",
    ]);
  });

  test("the refusal names the attributes feature and the owner-only rule", () => {
    const closed = new Map([
      ["attributeOptionIds", "attributes"],
      ["optionIds", "nonOwner"],
    ] as const);

    expect([
      closedFieldErrorOrNull(closed, ["attributeOptionIds"]),
      closedFieldErrorOrNull(closed, ["optionIds"]),
    ]).toEqual([
      "attributeOptionIds needs attributes turned on",
      "optionIds is owner-only",
    ]);
  });

  test("an answer leaves out each key whose feature is off, and no other key", () => {
    const hidden = (logistics: boolean) =>
      featureClosedKeys(FIELDS, {
        attributes: true,
        builder: true,
        logistics,
        subscriptions: true,
      });

    expect([hidden(false), hidden(true)]).toEqual([["is_public"], []]);
  });

  test("fieldOfKey finds the declared field, and refuses a key it does not declare", () => {
    expect(fieldOfKey(FIELDS, "note")).toBe(FIELDS[3]);
    expect(() => fieldOfKey(FIELDS, "missing" as "note")).toThrow(
      "No declared field missing",
    );
  });
});
