import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  ensureBuiltSiteSchedulerKey,
  ensureBuiltSiteSchedulerNextKey,
  promoteBuiltSiteSchedulerKey,
  readBuiltSiteScheduler,
} from "#shared/db/built-site-scheduler.ts";
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
    await expect(readBuiltSiteScheduler(999_999)).rejects.toThrow(
      "Built site not found",
    );
  });

  test("does not create a pending key before an active key", async () => {
    const site = await insertBuiltSite("Child", "child.example.test");
    await expect(ensureBuiltSiteSchedulerNextKey(site.id)).rejects.toThrow(
      "Cannot rotate a site with no active scheduled key",
    );
  });

  test("creates one active key across concurrent provisioning", async () => {
    const site = await insertBuiltSite("Child", "child.example.test");

    const [first, second] = await Promise.all([
      ensureBuiltSiteSchedulerKey(site.id),
      ensureBuiltSiteSchedulerKey(site.id),
    ]);

    expect(first.active).toBe(second.active);
    expect(first.active?.length).toBe(43);
    expect((await readBuiltSiteScheduler(site.id)).active).toBe(first.active);
  });

  test("creates or reuses one pending key across concurrent rotations", async () => {
    const site = await insertBuiltSite(
      "Child",
      "child.example.test",
      "",
      "",
      false,
      "",
      undefined,
      "bunny",
      "bunny",
      TEST_SCHEDULED_KEY,
    );

    const [first, second] = await Promise.all([
      ensureBuiltSiteSchedulerNextKey(site.id),
      ensureBuiltSiteSchedulerNextKey(site.id),
    ]);

    expect(first.pending).toBe(second.pending);
    expect(first.pending).not.toBe(TEST_SCHEDULED_KEY);
  });

  test("keeps an edit and a concurrent key rotation", async () => {
    const site = await insertBuiltSite(
      "Child",
      "child.example.test",
      "",
      "",
      false,
      "",
      undefined,
      "bunny",
      "bunny",
      TEST_SCHEDULED_KEY,
    );

    await Promise.all([
      ensureBuiltSiteSchedulerNextKey(site.id),
      builtSitesCrudTable.update(site.id, { name: "Edited child" }),
    ]);

    const updated = await builtSitesCrudTable.findById(site.id);
    expect(updated?.name).toBe("Edited child");
    expect(updated?.scheduledTaskKeyNext?.length).toBe(43);
  });

  test("promotes only the expected pending key", async () => {
    const site = await insertBuiltSite(
      "Child",
      "child.example.test",
      "",
      "",
      false,
      "",
      undefined,
      "bunny",
      "bunny",
      TEST_SCHEDULED_KEY,
    );
    const staged = await ensureBuiltSiteSchedulerNextKey(site.id);

    await expect(
      promoteBuiltSiteSchedulerKey(site.id, TEST_SCHEDULED_KEY),
    ).rejects.toThrow("Scheduled key changed while promoting site");
    await expect(
      promoteBuiltSiteSchedulerKey(site.id, "different"),
    ).rejects.toThrow("Scheduled key changed while promoting site");
    const promoted = await promoteBuiltSiteSchedulerKey(
      site.id,
      staged.pending!,
    );
    expect(promoted.active).toBe(staged.pending);
    expect(promoted.pending).toBeNull();
    expect(
      await promoteBuiltSiteSchedulerKey(site.id, staged.pending!),
    ).toEqual(promoted);
    await expect(
      promoteBuiltSiteSchedulerKey(site.id, "different"),
    ).rejects.toThrow("Scheduled key changed while promoting site");
  });
});
