/** The docs of a record whose route descriptions follow the common wording. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { recordDocsFor } from "#shared/admin-api-example/endpoint-doc.ts";
import { OPEN_ACCESS } from "#test/shared/admin-api-example/helpers.ts";

const PARTS = { createBody: {}, deleteBody: {}, example: {}, updateBody: {} };

const descriptionsOf = (
  ...args: Parameters<ReturnType<typeof recordDocsFor>>
): string[] =>
  recordDocsFor(OPEN_ACCESS)(...args).map((endpoint) => endpoint.description);

describe("record docs", () => {
  test("a record every admin can call names no caller", () => {
    expect(descriptionsOf("holidays", "a holiday", PARTS)).toEqual([
      "List all holidays",
      "Get a holiday by ID",
      "Create a holiday",
      "Update a holiday (all fields optional)",
      "Delete a holiday (requires name confirmation)",
    ]);
  });

  test("an owner-only record names the owner, and a path of two words reads as two words", () => {
    expect(
      descriptionsOf("attendee-statuses", "an attendee status", PARTS, "owner"),
    ).toEqual([
      "List all attendee statuses (owner only)",
      "Get an attendee status by ID (owner only)",
      "Create an attendee status (owner only)",
      "Update an attendee status (owner only, all fields optional)",
      "Delete an attendee status (owner only, requires name confirmation)",
    ]);
  });

  test("the routes are the routes of the resource the path names", () => {
    const routes = recordDocsFor(OPEN_ACCESS)("groups", "a group", PARTS).map(
      (endpoint) => `${endpoint.method} ${endpoint.path}`,
    );

    expect(routes).toEqual([
      "GET /api/admin/groups",
      "GET /api/admin/groups/:groupId",
      "POST /api/admin/groups",
      "PUT /api/admin/groups/:groupId",
      "DELETE /api/admin/groups/:groupId",
    ]);
  });
});
