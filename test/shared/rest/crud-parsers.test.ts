/** Direct unit tests for the CRUD API parsers extracted from crud-api.ts.
 *  The defineCrudApi integration tests in crud-api.test.ts exercise the full
 *  request path; these test the parsing helpers directly so mutation testing
 *  has a mirror for crud-parsers.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import * as v from "valibot";
import { ADMIN_API } from "#routes/auth.ts";
import { dateField, textField } from "#shared/rest/api-body-fields.ts";
import {
  bodyNumber,
  dateRange,
  optionalDateString,
  optionalTextField,
  parseApiBody,
  parseOptionalArray,
  parseUpdateSlug,
  requireDateString,
  requireEntityField,
  requireStrings,
  withApiEntity,
  withWriteName,
  writeEntityName,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestApiKeyToken, requestAsApiKey } from "#test-utils/session.ts";

test("requireStrings trims and extracts the named keys", () => {
  expect(requireStrings({ name: " mutated " }, ["name"])).toEqual({
    ok: true,
    value: { name: "mutated" },
  });
});

test("requireStrings names the first missing key", () => {
  expect(requireStrings({}, ["name", "start_date"])).toEqual({
    error: "name is required",
    ok: false,
  });
});

test("requireDateString trims and validates a real calendar day", () => {
  expect(
    requireDateString({ start_date: " 2027-06-01 " }, "start_date"),
  ).toEqual({ ok: true, value: "2027-06-01" });
  expect(requireDateString({ start_date: "2027-6-1" }, "start_date")).toEqual({
    error: "start_date has an invalid value",
    ok: false,
  });
  expect(requireDateString({ start_date: 42 }, "start_date")).toEqual({
    error: "start_date has an invalid value",
    ok: false,
  });
  expect(requireDateString({}, "start_date")).toEqual({
    error: "start_date is required",
    ok: false,
  });
});

test("optionalDateString keeps the fallback when the key is absent", () => {
  expect(optionalDateString({}, "start_date", "2026-01-01")).toEqual({
    ok: true,
    value: "2026-01-01",
  });
  expect(
    optionalDateString({ start_date: 42 }, "start_date", "2026-01-01"),
  ).toEqual({ error: "start_date has an invalid value", ok: false });
  expect(
    optionalDateString({ start_date: " 2027-06-01 " }, "start_date", "x"),
  ).toEqual({ ok: true, value: "2027-06-01" });
});

test("optionalDateString cleans a stored fallback date", () => {
  expect(optionalDateString({}, "start_date", " 2027-06-01 ")).toEqual({
    ok: true,
    value: "2027-06-01",
  });
});

test("optionalDateString stops loudly on an unusable stored fallback", () => {
  expect(() => optionalDateString({}, "start_date", "2027-6-1")).toThrow(
    "fallback does not hold a usable date: 2027-6-1",
  );
  expect(() => optionalDateString({}, "start_date", "not-a-date")).toThrow(
    "fallback does not hold a usable date: not-a-date",
  );
});

test("optionalTextField reads an optional text field", () => {
  expect(optionalTextField({}, "alt_text", "Stored alt")).toEqual({
    ok: true,
    value: "Stored alt",
  });
  expect(
    optionalTextField({ alt_text: " New alt " }, "alt_text", "Old"),
  ).toEqual({ ok: true, value: " New alt " });
  expect(optionalTextField({ name: 7 }, "name", "Stored")).toEqual({
    error: "name must be a string",
    ok: false,
  });
});

test("parseOptionalArray maps each entry through the parser", () => {
  expect(
    parseOptionalArray([1, 2], "items", (item) => okResult(Number(item))),
  ).toEqual({ ok: true, value: [1, 2] });
});

test("parseOptionalArray names a refused entry's index", () => {
  expect(
    parseOptionalArray([1, "two"], "items", (item, index) =>
      typeof item === "number"
        ? okResult(item)
        : { error: `items[${index}] must be a number`, ok: false },
    ),
  ).toEqual({ error: "items[1] must be a number", ok: false });
});

/** One body schema, so every parseApiBody case reads one shape. */
const NAME_BODY_SCHEMA = v.object({
  alt_text: v.optional(v.string()),
  name: textField("name").create,
});

test("parseApiBody answers the schema's own message for a wrong type", () => {
  expect(parseApiBody(NAME_BODY_SCHEMA, { name: 7 })).toEqual({
    error: "name must be a string",
    ok: false,
  });
  // Valibot names a missing object key itself. parseApiBody fills every
  // declared key in first, so the field's schema answers instead.
  expect(parseApiBody(NAME_BODY_SCHEMA, {})).toEqual({
    error: "name is required",
    ok: false,
  });
});

test("parseApiBody returns the parsed body", () => {
  expect(parseApiBody(NAME_BODY_SCHEMA, { name: "Poster" })).toEqual({
    ok: true,
    value: { name: "Poster" },
  });
});

test("parseUpdateSlug trims and lowercases the slug, deriving its index", async () => {
  expect(
    await parseUpdateSlug(
      { slug: " New Slug " },
      "old-slug",
      (slug) => slug.trim().toLowerCase().replaceAll(" ", "-"),
      (slug) => Promise.resolve(`index:${slug}`),
    ),
  ).toEqual({ slug: "new-slug", slugIndex: "index:new-slug" });
});

test("parseUpdateSlug keeps the existing slug when none is submitted", async () => {
  expect(
    await parseUpdateSlug(
      {},
      "old-slug",
      (slug) => slug,
      (slug) => Promise.resolve(`index:${slug}`),
    ),
  ).toEqual({ slug: "old-slug", slugIndex: "index:old-slug" });
});

test("requireEntityField trims the submitted name", () => {
  expect(requireEntityField({ name: " Updated " }, "name", "Original")).toEqual(
    {
      ok: true,
      value: "Updated",
    },
  );
});

test("requireEntityField falls back to the stored value when omitted", () => {
  expect(requireEntityField({}, "name", "Original")).toEqual({
    ok: true,
    value: "Original",
  });
});

test("requireEntityField rejects an empty value", () => {
  expect(requireEntityField({ name: "" }, "name", "Original")).toEqual({
    error: "name cannot be empty",
    ok: false,
  });
});

test("requireEntityField rejects a non-string value", () => {
  expect(requireEntityField({ name: 123 }, "name", "Original")).toEqual({
    error: "name must be a string",
    ok: false,
  });
  expect(requireEntityField({ name: null }, "name", "Original")).toEqual({
    error: "name must be a string",
    ok: false,
  });
});

test("requireEntityField names the field it reads", () => {
  expect(requireEntityField({}, "text", null)).toEqual({
    error: "text is required",
    ok: false,
  });
});

test("bodyNumber returns the number when present", () => {
  expect(bodyNumber({ count: 42 }, "count", 0)).toBe(42);
});

test("bodyNumber falls back when the key is missing or wrong type", () => {
  expect(bodyNumber({}, "count", 5)).toBe(5);
  expect(bodyNumber({ count: "nope" }, "count", 5)).toBe(5);
});

describeWithEnv("withApiEntity", { db: true }, () => {
  test("returns 404 when the lookup finds no row", async () => {
    const apiKey = await createTestApiKeyToken();
    const response = await withApiEntity(
      requestAsApiKey("/api/admin/widgets/999", apiKey),
      () => Promise.resolve(null),
      999,
      "Widget",
      () => Promise.resolve(new Response("should not be called")),
      ADMIN_API,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Widget not found" });
  });

  test("calls the handler when the row is found", async () => {
    const apiKey = await createTestApiKeyToken();
    const row = { id: 7, name: "Found" };
    const response = await withApiEntity(
      requestAsApiKey("/api/admin/widgets/7", apiKey),
      () => Promise.resolve(row),
      7,
      "Widget",
      (found) => Promise.resolve(Response.json({ widget: found })),
      ADMIN_API,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ widget: row });
  });
});

test("parseApiBody passes a schema that has no object entries", () => {
  expect(parseApiBody(v.unknown(), { name: "Poster" })).toEqual({
    ok: true,
    value: { name: "Poster" },
  });
});

test("dateField names a missing date", () => {
  const schema = v.object({ start_date: dateField("start_date").create });
  expect(parseApiBody(schema, {})).toEqual({
    error: "start_date is required",
    ok: false,
  });
});

test("writeEntityName reads the supplied or stored name", () => {
  expect(writeEntityName(" New ", "Stored")).toEqual({
    ok: true,
    value: "New",
  });
  expect(writeEntityName(undefined, "Stored")).toEqual({
    ok: true,
    value: "Stored",
  });
  expect(writeEntityName("  ", "Stored")).toEqual({
    error: "name cannot be empty",
    ok: false,
  });
  expect(writeEntityName(undefined, null)).toEqual({
    error: "name cannot be empty",
    ok: false,
  });
});

test("dateRange reports the end date refusal", () => {
  const start = requireDateString({ start_date: "2026-01-01" }, "start_date");
  expect(dateRange(start, errorResult("end date bad"))).toEqual({
    error: "end date bad",
    ok: false,
  });
});

test("withWriteName refuses an empty name before the mapper runs", () => {
  let mapped = false;
  const mapper = withWriteName<
    { name?: string | undefined },
    { name: string },
    { name: string }
  >((name) => {
    mapped = true;
    return okResult({ name });
  });

  expect(mapper({ name: "  " }, { name: "Stored" })).toEqual({
    error: "name cannot be empty",
    ok: false,
  });
  expect(mapped).toBe(false);
});
