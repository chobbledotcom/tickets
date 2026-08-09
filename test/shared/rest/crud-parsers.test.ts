/** Direct unit tests for the CRUD API parsers extracted from crud-api.ts.
 *  The defineCrudApi integration tests in crud-api.test.ts exercise the full
 *  request path; these test the parsing helpers directly so mutation testing
 *  has a mirror for crud-parsers.ts. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  bodyNumber,
  parseOptionalArray,
  parseUpdateName,
  parseUpdateSlug,
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

test("parseUpdateName trims the submitted name", () => {
  expect(parseUpdateName({ name: " Updated " }, "Original")).toEqual({
    ok: true,
    value: "Updated",
  });
});

test("parseUpdateName falls back to the existing name when omitted", () => {
  expect(parseUpdateName({}, "Original")).toEqual({
    ok: true,
    value: "Original",
  });
});

test("parseUpdateName rejects an empty name", () => {
  expect(parseUpdateName({ name: "" }, "Original")).toEqual({
    error: "name cannot be empty",
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
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ widget: row });
  });
});
