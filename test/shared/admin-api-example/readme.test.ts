/**
 * The README admin API section documents the groups list endpoint. Pin the
 * documented example so the README and the in-app reference cannot drift.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ADMIN_API_ENDPOINTS } from "#shared/admin-api-example.ts";
import { documented } from "./helpers.ts";

describe("README admin API example", () => {
  test("README.md shows the documented groups list response", async () => {
    const groupsList = documented(
      ADMIN_API_ENDPOINTS,
      "GET",
      "/api/admin/groups",
    );
    const readme = await Deno.readTextFile("README.md");
    expect(readme).toContain(groupsList.response);
  });
});
