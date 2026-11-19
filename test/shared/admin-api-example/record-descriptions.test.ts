/** The route descriptions of the records that share the common wording. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_API_ENDPOINTS } from "./helpers.ts";

/** The five record descriptions under one path, in documented order. */
const descriptionsUnder = (path: string): string[] =>
  ADMIN_API_ENDPOINTS.filter(
    (endpoint) =>
      endpoint.path === path || endpoint.path === `${path}/:${idOf(path)}`,
  ).map((endpoint) => endpoint.description);

const ID_PARAMS: Record<string, string> = {
  "/api/admin/attendee-statuses": "statusId",
  "/api/admin/attributes": "attributeId",
  "/api/admin/groups": "groupId",
  "/api/admin/holidays": "holidayId",
};

const idOf = (path: string): string => {
  const id = ID_PARAMS[path];
  if (id === undefined) throw new Error(`No id param for ${path}`);
  return id;
};

/* jscpd:ignore-start -- a list of strings, not code */
const EXPECTED: Record<string, string[]> = {
  "/api/admin/attendee-statuses": [
    "List all attendee statuses (owner only)",
    "Get an attendee status by ID (owner only)",
    "Create an attendee status (owner only)",
    "Update an attendee status (owner only, all fields optional)",
    "Delete an attendee status (owner only, requires name confirmation)",
  ],
  "/api/admin/attributes": [
    "List all attributes (owner only)",
    "Get an attribute by ID (owner only)",
    "Create an attribute (owner only)",
    "Update an attribute (owner only, all fields optional)",
    "Delete an attribute (owner only, requires name confirmation)",
  ],
  "/api/admin/groups": [
    "List all groups",
    "Get a group by ID",
    "Create a group",
    "Update a group (all fields optional)",
    "Delete a group (requires name confirmation)",
  ],
  "/api/admin/holidays": [
    "List all holidays (owner only)",
    "Get a holiday by ID (owner only)",
    "Create a holiday (owner only)",
    "Update a holiday (owner only, all fields optional)",
    "Delete a holiday (owner only, requires name confirmation)",
  ],
};
/* jscpd:ignore-end */

describe("record route descriptions", () => {
  test("each record follows the common wording, and an owner-only record names the owner", () => {
    const described = Object.fromEntries(
      Object.keys(ID_PARAMS).map((path) => [path, descriptionsUnder(path)]),
    );

    expect(described).toEqual(EXPECTED);
  });
});
