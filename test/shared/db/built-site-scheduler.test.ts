import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { ensureBuiltSiteSchedulerKey } from "#shared/db/built-site-scheduler.ts";
import {
  builtSitesCrudTable,
  insertBuiltSite,
} from "#shared/db/built-sites.ts";
import { queryOne } from "#shared/db/client.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_SCHEDULED_KEY } from "#test-utils/scheduled.ts";

describeWithEnv("built-site scheduler keys", { db: true }, () => {
  test("stores the active key only inside encrypted site data", async () => {
    const row = await insertBuiltSite(
      "Child",
      "child.example.test",
      "",
      "",
      false,
      "42",
      undefined,
      "bunny",
      "bunny",
      TEST_SCHEDULED_KEY,
    );

    const raw = await queryOne<{ site_data: string }>(
      "SELECT site_data FROM built_sites WHERE id = ?",
      [row.id],
    );
    expect(raw?.site_data).not.toContain(TEST_SCHEDULED_KEY);
    expect(JSON.stringify(raw)).not.toContain(TEST_SCHEDULED_KEY);
    expect((await builtSitesCrudTable.findById(row.id))?.scheduledTaskKey).toBe(
      TEST_SCHEDULED_KEY,
    );
  });

  test("fails loudly when the built site does not exist", async () => {
    await expect(ensureBuiltSiteSchedulerKey(999_999)).rejects.toThrow(
      "Built site not found",
    );
  });

  test("creates one active key across concurrent provisioning", async () => {
    const site = await insertBuiltSite("Child", "child.example.test");

    const [first, second] = await Promise.all([
      ensureBuiltSiteSchedulerKey(site.id),
      ensureBuiltSiteSchedulerKey(site.id),
    ]);

    expect(first).toBe(second);
    expect(first.length).toBe(43);
    expect(
      (await builtSitesCrudTable.findById(site.id))?.scheduledTaskKey,
    ).toBe(first);
  });

  test("keeps an edit and concurrent key provisioning", async () => {
    const site = await insertBuiltSite("Child", "child.example.test");

    await Promise.all([
      ensureBuiltSiteSchedulerKey(site.id),
      builtSitesCrudTable.update(site.id, { name: "Edited child" }),
    ]);

    const updated = await builtSitesCrudTable.findById(site.id);
    expect(updated?.name).toBe("Edited child");
    expect(updated?.scheduledTaskKey?.length).toBe(43);
  });
});
