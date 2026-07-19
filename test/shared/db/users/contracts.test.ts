import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hashPassword } from "#shared/crypto/hashing.ts";
import { generateDataKey, wrapKeyWithToken } from "#shared/crypto/keys.ts";
import { execute } from "#shared/db/client.ts";
import {
  acceptInvite,
  activateKeylessUser,
  createInvitedUser,
  createUser,
  decryptAdminLevel,
  decryptUsername,
  deleteUser,
  getAllUsers,
  getUserById,
  getUserByUsername,
  getUserDisplayFields,
  hashInviteCode,
  invalidateUsersCache,
  isUsernameTaken,
  migrateUserToV2Kek,
  verifyUserPassword,
} from "#shared/db/users.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { TEST_ADMIN_USERNAME } from "#test-utils/internal.ts";
import { recordQueries } from "#test-utils/record-queries.ts";
import {
  addUserOwnedAccessRecords,
  getUserOwnedRowSources,
} from "#test-utils/user-owned-records.ts";

describeWithEnv("db > users contracts", { db: true }, () => {
  test("returns every display field in user id order", async () => {
    const invited = await createInvitedUser(
      "display-user",
      "editor",
      "display-invite",
      "2099-01-01T00:00:00.000Z",
    );

    const fields = await getUserDisplayFields();

    expect(fields.map(({ id }) => id)).toEqual([1, invited.id]);
    expect(await Promise.all(fields.map(decryptUsername))).toEqual([
      TEST_ADMIN_USERNAME,
      "display-user",
    ]);
    expect(await Promise.all(fields.map(decryptAdminLevel))).toEqual([
      "owner",
      "editor",
    ]);
  });

  test("keeps the full user list cached within its lifetime", async () => {
    invalidateUsersCache();
    const queries: string[] = [];
    const restore = recordQueries(queries);
    try {
      await getAllUsers();
      await getAllUsers();
    } finally {
      restore();
    }

    expect(
      queries.filter((sql) => sql.includes("FROM users ORDER BY id ASC")),
    ).toHaveLength(1);
  });

  test("reports the users cache name and entry count", async () => {
    invalidateUsersCache();
    await getAllUsers();

    expect(getAllCacheStats().filter(({ name }) => name === "users")).toEqual([
      { entries: 1, name: "users" },
    ]);
  });

  test("invalidates cached users after a users table write", async () => {
    await createInvitedUser(
      "changed-role",
      "manager",
      "changed-role-invite",
      "2099-01-01T00:00:00.000Z",
    );
    const cached = (await getUserByUsername("changed-role"))!;
    expect(await decryptAdminLevel(cached)).toBe("manager");

    await execute("UPDATE users SET admin_level = ? WHERE id = ?", [
      await encrypt("editor"),
      cached.id,
    ]);

    expect(
      await decryptAdminLevel((await getUserByUsername("changed-role"))!),
    ).toBe("editor");
  });

  test("creates activated users with the password-bound KEK version", async () => {
    const user = await createUser("active-user", "", null, "manager");

    expect(user.kek_version).toBe(2);
    expect(user.invite_code_hash).toBeNull();
    expect(user.invite_expiry).toBeNull();
  });

  test("finds taken usernames without marking a missing name as taken", async () => {
    await createInvitedUser(
      "taken-user",
      "manager",
      "taken-invite",
      "2099-01-01T00:00:00.000Z",
    );

    expect(await isUsernameTaken("TAKEN-USER")).toBe(true);
    expect(await isUsernameTaken("available-user")).toBe(false);
  });

  test("activates a keyless user once and clears the invite", async () => {
    const user = await createInvitedUser(
      "keyless-user",
      "editor",
      "keyless-invite",
      "2099-01-01T00:00:00.000Z",
    );
    expect(user.kek_version).toBe(1);

    expect(await activateKeylessUser(user.id, "keyless-pass")).toBe(true);
    const activated = (await getUserById(user.id))!;
    expect(activated.kek_version).toBe(2);
    expect(await decrypt(activated.invite_code_hash!)).toBe("");
    expect(await decrypt(activated.invite_expiry!)).toBe("");
    expect(
      (await verifyUserPassword(activated, "keyless-pass"))?.split(":")[0],
    ).toBe("pbkdf2");
    expect(await activateKeylessUser(user.id, "replacement-pass")).toBe(false);
  });

  test("accepts a key handoff and clears its single-use invite fields", async () => {
    const inviteCode = "handoff-code";
    const handoff = await wrapKeyWithToken(await generateDataKey(), inviteCode);
    const user = await createInvitedUser(
      "handoff-user",
      "manager",
      await hashInviteCode(inviteCode),
      "2099-01-01T00:00:00.000Z",
      handoff,
    );

    expect(
      await acceptInvite(user.id, handoff, inviteCode, "handoff-pass"),
    ).toBe(true);
    const activated = (await getUserById(user.id))!;
    expect(activated.kek_version).toBe(2);
    expect(activated.wrapped_data_key).not.toBeNull();
    expect(activated.invite_wrapped_data_key).toBeNull();
    expect(await decrypt(activated.invite_code_hash!)).toBe("");
    expect(await decrypt(activated.invite_expiry!)).toBe("");
  });

  test("migrates a legacy user to the password-bound KEK version", async () => {
    const password = "legacy-pass";
    const passwordHash = await hashPassword(password);
    const user = await createUser(
      "legacy-user",
      passwordHash,
      null,
      "manager",
      1,
    );

    await migrateUserToV2Kek(
      user.id,
      await generateDataKey(),
      password,
      passwordHash,
    );

    const migrated = (await getUserById(user.id))!;
    expect(migrated.kek_version).toBe(2);
    expect(migrated.wrapped_data_key).not.toBeNull();
  });

  test("deletes the user and every owned access record", async () => {
    const user = await createInvitedUser(
      "deleted-agent",
      "agent",
      "delete-invite",
      "2099-01-01T00:00:00.000Z",
    );
    await addUserOwnedAccessRecords(user.id, "delete");
    expect(await getUserOwnedRowSources(user.id)).toEqual([
      "api_keys",
      "sessions",
      "user_logistics_agents",
      "users",
    ]);

    await deleteUser(user.id);

    expect(await getUserOwnedRowSources(user.id)).toEqual([]);
  });
});
