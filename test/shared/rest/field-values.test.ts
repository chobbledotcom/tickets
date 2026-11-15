/** The one value rule of each field kind, and the API views, refusals, and
 *  transfer schema that derive from it. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import type { FieldKind, FieldSpec } from "#shared/rest/field-specs.ts";
import {
  apiFieldsOf,
  apiRefusal,
  fieldValueSchema,
  isWholeNumberField,
  transferSchema,
} from "#shared/rest/field-values.ts";
import { MAX_DURATION_DAYS } from "#types";

/* jscpd:ignore-start -- a list of strings, not code */
const PLAIN_FIELDS = [
  { key: "start_date", kind: "date" },
  { key: "name", kind: "name" },
  { key: "is_public", kind: "switch" },
  { key: "note", kind: "text" },
  { key: "date", kind: "datetime" },
  { key: "closes_at", kind: "optionalDatetime" },
  { key: "duration_days", kind: "durationDays" },
  { key: "unit_price", kind: "price" },
] as const;
/* jscpd:ignore-end */

/** Every field kind, so a new kind joins the whole-number check. */
const FIELD_KINDS: Record<FieldKind, true> = {
  contactFields: true,
  count: true,
  date: true,
  datetime: true,
  dayPrices: true,
  durationDays: true,
  listingType: true,
  name: true,
  optionalDatetime: true,
  price: true,
  privateText: true,
  switch: true,
  text: true,
  weekdays: true,
};

const FIELDS = [
  ...PLAIN_FIELDS,
  { key: "seats", kind: "count", min: 1 },
] as const;

/** The issue message one schema answers for a value, or the parsed value. */
const viewAnswer = (schema: v.GenericSchema, value: unknown) => {
  const result = v.safeParse(schema, value);
  return result.success
    ? { ok: true, value: result.output }
    : { error: result.issues[0].message, ok: false };
};

const refused = (error: string) => ({ error, ok: false });
const accepted = (value: unknown) => ({ ok: true, value });

/** True when the value rule of one field of the kind accepts the value. */
const accepts = (field: Omit<FieldSpec, "key">, value: unknown): boolean =>
  v.is(fieldValueSchema({ ...field, key: "x" }), value);

/** One field of a kind, the values its rule must take, and the values it must
 *  refuse. */
type ValueRule = [Omit<FieldSpec, "key">, unknown[], unknown[]];

/** Checks each field takes exactly its good values and refuses its bad ones. */
const expectRules = (rules: ValueRule[]): void => {
  const answers = rules.map(([field, good, bad]) => [
    field,
    good.map((value) => accepts(field, value)),
    bad.map((value) => accepts(field, value)),
  ]);
  expect(answers).toEqual(
    rules.map(([field, good, bad]) => [
      field,
      good.map(() => true),
      bad.map(() => false),
    ]),
  );
};

describe("field values", () => {
  test("apiFieldsOf gives each field the wire views of its own kind", () => {
    const views = apiFieldsOf(FIELDS);
    const cases: [v.GenericSchema, unknown, object][] = [
      [views.start_date.create, 5, refused("start_date has an invalid value")],
      [views.start_date.create, undefined, refused("start_date is required")],
      [views.name.create, " Summer ", accepted("Summer")],
      [views.name.create, 5, refused("name must be a string")],
      [views.is_public.create, undefined, accepted(undefined)],
      [views.is_public.update, "yes", refused("is_public must be a boolean")],
      [views.note.create, undefined, accepted(undefined)],
      [views.note.update, 1, refused("note must be a string")],
      [views.seats.create, undefined, accepted(undefined)],
      [views.seats.update, 2, accepted(2)],
    ];
    expect(Object.keys(views)).toEqual(FIELDS.map((field) => field.key));
    expect(cases.map(([schema, value]) => viewAnswer(schema, value))).toEqual(
      cases.map(([, , answer]) => answer),
    );
    expect(v.is(views.seats.update, 0)).toBe(false);
  });

  test("a count takes whole numbers from its own minimum", () => {
    expectRules([
      [{ kind: "count", min: 0 }, [0], [-1, Number.MAX_SAFE_INTEGER + 1]],
      [{ kind: "count", min: 1 }, [], [0, 1.5]],
      [{ kind: "count" }, [0], []],
    ]);
  });

  test("each listing kind takes only the values its column holds", () => {
    expectRules([
      [{ kind: "price" }, [0], [-1]],
      [{ kind: "weekdays" }, [["Monday"]], [["monday"]]],
      [{ kind: "listingType" }, ["daily"], ["weekly"]],
      [{ kind: "contactFields" }, ["email,phone"], ["email,fax"]],
      [
        { kind: "durationDays" },
        [1, MAX_DURATION_DAYS],
        [0, MAX_DURATION_DAYS + 1],
      ],
      [
        { kind: "dayPrices" },
        [{ 1: 0, 2: 1800 }],
        [{ 2: -1 }, { weekday: 100 }],
      ],
      [{ kind: "privateText" }, ["Hall"], [4]],
    ]);
  });

  test("a datetime takes only a UTC time of a real day, and a listing date also takes empty", () => {
    expectRules([
      [
        { kind: "datetime" },
        ["", "2026-06-01T10:00:00.000Z"],
        ["2026-06-01T10:00", "2026-06-01T10:00+01:00", "2026-02-30T10:00Z"],
      ],
      [{ kind: "optionalDatetime" }, [null, "2026-06-01T10:00Z"], [""]],
    ]);
  });

  test("a date takes only a real calendar day", () => {
    expectRules([
      [
        { kind: "date" },
        ["2026-02-28"],
        ["2026-02-30", "", "2026-06-01T10:00Z"],
      ],
    ]);
  });

  test("a contact list comes back tidy, and a bad entry names its rule", () => {
    const rule = (kind: FieldKind) => fieldValueSchema({ key: "x", kind });
    expect([
      viewAnswer(rule("contactFields"), " email , phone "),
      viewAnswer(rule("contactFields"), "fax"),
      viewAnswer(rule("dayPrices"), { weekday: 100 }),
    ]).toEqual([
      accepted("email,phone"),
      refused("must be a known contact field"),
      refused("day count must be a positive whole number"),
    ]);
  });

  test("the API refusal names the field, with the rule for a date or a duration", () => {
    const refusals = FIELDS.map((field) => [field.key, apiRefusal(field)]);
    expect(Object.fromEntries(refusals)).toEqual({
      closes_at: "closes_at must be a UTC instant of a real calendar day",
      date: "date must be a UTC instant of a real calendar day",
      duration_days: `duration_days must be a whole number from 1 to ${MAX_DURATION_DAYS}`,
      is_public: "is_public has an invalid value",
      name: "name has an invalid value",
      note: "note has an invalid value",
      seats: "seats has an invalid value",
      start_date: "start_date has an invalid value",
      unit_price: "unit_price has an invalid value",
    });
  });

  test("only a count takes the whole-number form rule", () => {
    const kinds = Object.keys(FIELD_KINDS) as FieldKind[];
    expect(kinds.filter((kind) => isWholeNumberField({ kind }))).toEqual([
      "count",
    ]);
    expect(FIELDS.filter(isWholeNumberField).map(({ key }) => key)).toEqual([
      "seats",
    ]);
  });

  test("the transfer schema reads every field by input name, exactly", () => {
    const schema = transferSchema([
      { key: "name", kind: "name", required: true },
      { key: "max_quantity", kind: "count", min: 1 },
    ] as const);

    expect([
      viewAnswer(schema, { maxQuantity: 2, name: " Hall " }),
      viewAnswer(schema, { name: "Hall" }),
      v.is(schema, { maxQuantity: 2 }),
      v.is(schema, { name: "Hall", webhook: "https://example.com" }),
      v.is(schema, { maxQuantity: 0, name: "Hall" }),
    ]).toEqual([
      accepted({ maxQuantity: 2, name: "Hall" }),
      accepted({ name: "Hall" }),
      false,
      false,
      false,
    ]);
  });
});
