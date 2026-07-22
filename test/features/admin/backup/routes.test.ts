import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import {
  getSubrequestUsage,
  runWithSubrequestBudget,
} from "#shared/subrequest-budget.ts";

test("web restore paths are absent and use no subrequests", async () => {
  const handlers = await ADMIN_AREA_LOADERS.backup.load();

  await runWithSubrequestBudget(async () => {
    for (const path of [
      "POST /admin/backup/restore",
      "POST /admin/backup/restore/confirm",
    ]) {
      expect(Object.hasOwn(handlers, path)).toBe(false);
    }
    expect(getSubrequestUsage()).toEqual({
      database: 0,
      external: 0,
      total: 0,
    });
  });
});
