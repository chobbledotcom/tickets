import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { createInvitedUser, getAllUsers } from "#shared/db/users.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addUserOwnedAccessRecords,
  getUserOwnedRowSources,
} from "#test-utils/user-owned-records.ts";

const createInvite = (username: string, expiry: string) =>
  createInvitedUser(username, "agent", `${username}-invite`, expiry);

describeWithEnv("db > expired invite pruning", { db: true }, () => {
  test("removes every expired invite and its owned access records", async () => {
    const first = await createInvite(
      "expired-first",
      "2000-01-01T00:00:00.000Z",
    );
    const second = await createInvite(
      "expired-second",
      "2000-01-02T00:00:00.000Z",
    );
    const future = await createInvite(
      "future-invite",
      "2099-01-01T00:00:00.000Z",
    );
    await addUserOwnedAccessRecords(first.id, "expired-first");
    await addUserOwnedAccessRecords(future.id, "future-invite");
    expect(await getUserOwnedRowSources(first.id)).toEqual([
      "api_keys",
      "sessions",
      "user_logistics_agents",
      "users",
    ]);
    expect(await getUserOwnedRowSources(second.id)).toEqual(["users"]);

    await runDatabasePruning();

    expect(await getUserOwnedRowSources(first.id)).toEqual([]);
    expect(await getUserOwnedRowSources(second.id)).toEqual([]);
    expect(await getUserOwnedRowSources(future.id)).toEqual([
      "api_keys",
      "sessions",
      "user_logistics_agents",
      "users",
    ]);
  });

  test("keeps the users cache warm when no invite has expired", async () => {
    await createInvite("current-invite", "2099-01-01T00:00:00.000Z");
    await getAllUsers();
    const usersStat = () =>
      getAllCacheStats().find(({ name }) => name === "users")?.entries;
    expect(usersStat()).toBe(2);

    await runDatabasePruning();

    expect(usersStat()).toBe(2);
  });
});
