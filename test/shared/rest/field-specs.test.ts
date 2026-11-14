/** The values one field list builds, keyed by its columns, and the wire views
 *  each field kind gives. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  apiFieldsOf,
  byFieldKey,
  byFieldKind,
} from "#shared/rest/field-specs.ts";

const FIELDS = [
  { key: "start_date", kind: "date" },
  { key: "name", kind: "name" },
  { key: "is_public", kind: "switch" },
  { key: "note", kind: "text" },
] as const;

/** The issue message one view answers for a value, or the parsed value. */
const viewAnswer = (schema: v.GenericSchema, value: unknown) => {
  const result = v.safeParse(schema, value);
  return result.success
    ? { ok: true, value: result.output }
    : { error: result.issues[0].message, ok: false };
};

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
    const lengths = { date: 10, name: 1, switch: 0, text: 2 } as const;
    expect(
      byFieldKind<typeof FIELDS, typeof lengths>(
        FIELDS,
        (field) => lengths[field.kind],
      ),
    ).toEqual({ is_public: 0, name: 1, note: 2, start_date: 10 });
  });

  test("apiFieldsOf gives each field the wire views of its own kind", () => {
    const views = apiFieldsOf(FIELDS);
    expect(Object.keys(views).sort()).toEqual([
      "is_public",
      "name",
      "note",
      "start_date",
    ]);
    const refused = (error: string) => ({ error, ok: false });
    const accepted = (value: unknown) => ({ ok: true, value });
    const cases: [v.GenericSchema, unknown, object][] = [
      [views.start_date.create, 5, refused("start_date has an invalid value")],
      [views.start_date.create, undefined, refused("start_date is required")],
      [views.name.create, " Summer ", accepted("Summer")],
      [views.name.create, 5, refused("name must be a string")],
      [views.is_public.create, undefined, accepted(undefined)],
      [views.is_public.update, "yes", refused("is_public must be a boolean")],
      [views.note.create, undefined, accepted(undefined)],
      [views.note.update, 1, refused("note must be a string")],
    ];
    expect(cases.map(([schema, value]) => viewAnswer(schema, value))).toEqual(
      cases.map(([, , answer]) => answer),
    );
  });
});
