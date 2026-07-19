import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { executeBatch } from "#shared/db/client.ts";
import { runDatabasePruning } from "#shared/db/prune.ts";
import { createInvitedUser, getAllUsers } from "#shared/db/users.ts";
import { MAINTENANCE_PRUNE_BATCH } from "#shared/limits.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  addUserOwnedAccessRecords,
  getUserOwnedRowSources,
} from "#test-utils/user-owned-records.ts";

const createInvite = (username: string, expiry: string) =>
  createInvitedUser(username, "agent", `${username}-invite`, expiry);

const cloneInvites = (
  sourceId: number,
  prefix: string,
  count: number,
): Promise<void> =>
  executeBatch(
    Array.from({ length: count }, (_, index) => ({
      args: [`${prefix}-${index}`, sourceId],
      sql: `INSERT INTO users (
              username_hash, username_index, password_hash, wrapped_data_key,
              admin_level, invite_code_hash, invite_expiry, kek_version,
              invite_wrapped_data_key
            )
            SELECT username_hash, ?, password_hash, wrapped_data_key,
                   admin_level, invite_code_hash, invite_expiry, kek_version,
                   invite_wrapped_data_key
              FROM users WHERE id = ?`,
    })),
  );

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

  test("removes an expired invite after a full batch of current invites", async () => {
    const current = await createInvite(
      "current-first",
      "2099-01-01T00:00:00.000Z",
    );
    await cloneInvites(
      current.id,
      "current-clone",
      MAINTENANCE_PRUNE_BATCH - 1,
    );
    const expired = await createInvite(
      "expired-after-current",
      "2000-01-01T00:00:00.000Z",
    );

    await runDatabasePruning();

    expect(await getUserOwnedRowSources(expired.id)).toEqual([]);
    expect(await getUserOwnedRowSources(current.id)).toEqual(["users"]);
  });
});
