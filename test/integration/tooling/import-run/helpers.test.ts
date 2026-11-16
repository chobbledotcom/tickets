import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { scriptedApi } from "#test/integration/tooling/import-run/helpers.ts";

test("the scripted API records a call it has no route for, then refuses it", async () => {
  const { api, calls } = scriptedApi({});

  await expect(
    api({ body: undefined, method: "GET", path: "/api/admin/groups" }),
  ).rejects.toThrow("unexpected API call: GET /api/admin/groups");
  expect(calls).toEqual([
    { body: undefined, method: "GET", path: "/api/admin/groups" },
  ]);
});
