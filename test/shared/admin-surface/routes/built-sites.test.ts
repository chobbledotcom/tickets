import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";

test("declares every scheduler owner action as a blocked POST route", () => {
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
    {
      area: "builtSites",
      id: "postBuiltSitesByIdStageScheduler",
      method: "POST",
      pattern: "/admin/built-sites/:id/stage-scheduler",
      readOnly: "block",
    },
    {
      area: "builtSites",
      id: "postBuiltSitesByIdPromoteScheduler",
      method: "POST",
      pattern: "/admin/built-sites/:id/promote-scheduler",
      readOnly: "block",
    },
  ]);
});
