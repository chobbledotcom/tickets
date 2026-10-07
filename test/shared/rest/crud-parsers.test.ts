/** Direct unit tests for the CRUD API parsers extracted from crud-api.ts.
 *  The defineCrudApi integration tests in crud-api.test.ts exercise the full
 *  request path; these test the parsing helpers directly so mutation testing
 *  has a mirror for crud-parsers.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_API } from "#routes/auth.ts";
import {
  bodyNumber,
  optionalDateString,
  parseOptionalArray,
  parseUpdateSlug,
  requireDateString,
  requireEntityName,
  requireStrings,
  withApiEntity,
} from "#shared/rest/crud-parsers.ts";
import { okResult } from "#shared/result.ts";
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
  expect(() => optionalDateString({}, "start_date", "2026-02-30")).toThrow(
    "start_date fallback does not hold a usable date: 2026-02-30",
  );
});

test("optionalDateString repairs a legacy unpadded stored fallback", () => {
  expect(optionalDateString({}, "start_date", "2027-6-1")).toEqual({
    ok: true,
    value: "2027-06-01",
  });
});

test("parseOptionalArray maps each entry through the parser", () => {
  expect(
    parseOptionalArray([1, 2], "items", (item) => okResult(Number(item))),
  ).toEqual({ ok: true, value: [1, 2] });
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

test("requireEntityName trims the submitted name", () => {
  expect(requireEntityName({ name: " Updated " }, "Original")).toEqual({
    ok: true,
    value: "Updated",
  });
});

test("requireEntityName falls back to the existing name when omitted", () => {
  expect(requireEntityName({}, "Original")).toEqual({
    ok: true,
    value: "Original",
  });
});

test("requireEntityName rejects an empty name", () => {
  expect(requireEntityName({ name: "" }, "Original")).toEqual({
    error: "name cannot be empty",
    ok: false,
  });
});

test("requireEntityName rejects a non-string name", () => {
  expect(requireEntityName({ name: 123 }, "Original")).toEqual({
    error: "name must be a string",
    ok: false,
  });
  expect(requireEntityName({ name: null }, "Original")).toEqual({
    error: "name must be a string",
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
