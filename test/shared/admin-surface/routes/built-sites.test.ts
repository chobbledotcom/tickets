import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";

test("keeps the complete built-site route catalog exact", async () => {
  expect(Object.keys(await ADMIN_AREA_LOADERS.builtSites.load())).toEqual([
    "GET /admin/built-sites",
    "GET /admin/built-sites/:id",
    "GET /admin/built-sites/:id/:tab",
    "GET /admin/built-sites/:id/delete",
    "GET /admin/built-sites/new",
    "POST /admin/built-sites",
    "POST /admin/built-sites/:id/add-secrets",
    "POST /admin/built-sites/:id/bump-deadline",
    "POST /admin/built-sites/:id/delete",
    "POST /admin/built-sites/:id/edit",
    "POST /admin/built-sites/:id/override-deadline",
    "POST /admin/built-sites/:id/provision-renewal",
    "POST /admin/built-sites/:id/provision-scheduler",
    "POST /admin/built-sites/:id/re-sync-deadline",
    "POST /admin/built-sites/:id/rotate-renewal-token",
    "POST /admin/built-sites/:id/update",
  ]);
});

test("routes the scheduler provisioning action as a POST", async () => {
  expect(Object.keys(await ADMIN_AREA_LOADERS.builtSites.load())).toContain(
    "POST /admin/built-sites/:id/provision-scheduler",
  );
});
