import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete built-site route catalog exact", async () => {
  const routes = ADMIN_SURFACE.routes.filter(
    ({ area }) => area === "builtSites",
  );

  expect(await jsonHash(routes)).toBe(
    "ad669c386d0694be463bbe43624a6d7bc0cd6364043d9b27e540f9a6db43a6a6",
  );
});

test("declares the scheduler provisioning action as a blocked POST route", () => {
  expect(
    ADMIN_SURFACE.routes.filter(({ id }) => id.includes("Scheduler")),
  ).toEqual([
    {
      area: "builtSites",
      id: "postBuiltSitesByIdProvisionScheduler",
      method: "POST",
      pattern: "/admin/built-sites/:id/provision-scheduler",
      readOnly: "block",
    },
  ]);
});
