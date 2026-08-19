/**
 * Reading stored group rows: one, several, or none. Asking for none must not
 * touch the database at all — a page that resolves an empty list of groups
 * should not spend one of the request's fifty subrequests on it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getGroupById, getGroupsByIds } from "#db/groups.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

describeWithEnv("db > stored group reads", { db: true }, () => {
  test("reads several groups by id in one query", async () => {
    const first = await createTestGroup({ name: "Read first" });
    const second = await createTestGroup({ name: "Read second" });

    const calls = await countDatabaseCalls(1, async () => {
      const found = await getGroupsByIds([first.id, second.id]);
      expect([...found.keys()].toSorted()).toEqual(
        [first.id, second.id].toSorted(),
      );
      expect(found.get(first.id)?.name).toBe("Read first");
    });
    expect(calls).toBe(1);
  });

  test("asks the database nothing when no id was given", async () => {
    const calls = await countDatabaseCalls(0, async () => {
      expect(await getGroupsByIds([])).toEqual(new Map());
    });
    expect(calls).toBe(0);
  });

  test("reads one group by id", async () => {
    const group = await createTestGroup({ name: "Read single" });

    expect((await getGroupById(group.id))?.name).toBe("Read single");
  });

  test("has no group for an id that names nothing", async () => {
    expect(await getGroupById(999_999)).toBeNull();
  });
});
