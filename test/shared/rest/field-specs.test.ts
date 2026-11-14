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
    expect(viewAnswer(views.start_date.create, 5)).toEqual({
      error: "start_date has an invalid value",
      ok: false,
    });
    expect(viewAnswer(views.start_date.create, undefined)).toEqual({
      error: "start_date is required",
      ok: false,
    });
    expect(viewAnswer(views.name.create, " Summer ")).toEqual({
      ok: true,
      value: "Summer",
    });
    expect(viewAnswer(views.name.create, 5)).toEqual({
      error: "name must be a string",
      ok: false,
    });
    expect(viewAnswer(views.is_public.create, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(viewAnswer(views.is_public.update, "yes")).toEqual({
      error: "is_public must be a boolean",
      ok: false,
    });
    expect(viewAnswer(views.note.create, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(viewAnswer(views.note.update, 1)).toEqual({
      error: "note must be a string",
      ok: false,
    });
  });
});
