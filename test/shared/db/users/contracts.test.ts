import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { decrypt, encrypt } from "#crypto/encryption.ts";
import { hashPassword } from "#crypto/hashing.ts";
import { generateDataKey, wrapKeyWithToken } from "#crypto/keys.ts";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import {
  acceptInvite,
  activateKeylessUser,
  migrateUserToV2Kek,
} from "#db/user-activation.ts";
import {
  createInvitedUser,
  createUser,
  decryptAdminLevel,
  decryptUsername,
  deleteUser,
  getAllUsers,
  getUserAuthFieldsById,
  getUserById,
  getUserByUsername,
  getUserDisplayFields,
  hashInviteCode,
  invalidateUsersCache,
  isInviteExpired,
  isInviteValid,
  isUsernameTaken,
  verifyUserPassword,
} from "#db/users.ts";
import { getAllCacheStats } from "#shared/cache-registry.ts";
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

  test("returns the exact authentication row for one user", async () => {
    const invited = await createInvitedUser(
      "auth-fields-user",
      "manager",
      "auth-fields-invite",
      "2099-01-01T00:00:00.000Z",
    );

    expect(await getUserAuthFieldsById(invited.id)).toEqual({
      admin_level: invited.adminLevel,
      id: invited.id,
    });
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

    await execute(
      sql`UPDATE users SET admin_level = ${await encrypt("editor")} WHERE id = ${cached.id}`,
    );

    expect(
      await decryptAdminLevel((await getUserByUsername("changed-role"))!),
    ).toBe("editor");
  });

  test("creates activated users with the password-bound KEK version", async () => {
    const user = await createUser("active-user", "", null, "manager");

    expect(user.kekVersion).toBe(2);
    expect(user.inviteCodeHash).toBeNull();
    expect(user.inviteExpiry).toBeNull();
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

  test("classifies every incomplete, current, and expired invite state", async () => {
    const current = await createInvitedUser(
      "invite-states",
      "manager",
      "invite-hash",
      "2099-01-01T00:00:00.000Z",
    );
    const expired = {
      ...current,
      invite_expiry: await encrypt("2020-01-01T00:00:00.000Z"),
    };
    const states = [
      { ...current, invite_code_hash: null },
      { ...current, invite_code_hash: await encrypt("") },
      { ...current, invite_expiry: null },
      { ...current, invite_expiry: await encrypt("") },
      current,
      expired,
    ];

    expect(await Promise.all(states.map(isInviteValid))).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
    expect(await Promise.all(states.map(isInviteExpired))).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
    ]);
  });

  test("activates a keyless user once and clears the invite", async () => {
    const user = await createInvitedUser(
      "keyless-user",
      "editor",
      "keyless-invite",
      "2099-01-01T00:00:00.000Z",
    );
    expect(user.kekVersion).toBe(1);

    expect(await activateKeylessUser(user.id, "keyless-pass")).toBe(true);
    const activated = (await getUserById(user.id))!;
    expect(activated.kekVersion).toBe(2);
    expect(await decrypt(activated.inviteCodeHash!)).toBe("");
    expect(await decrypt(activated.inviteExpiry!)).toBe("");
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
    expect(activated.kekVersion).toBe(2);
    expect(activated.wrappedDataKey).not.toBeNull();
    expect(activated.inviteWrappedDataKey).toBeNull();
    expect(await decrypt(activated.inviteCodeHash!)).toBe("");
    expect(await decrypt(activated.inviteExpiry!)).toBe("");
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
    expect(migrated.kekVersion).toBe(2);
    expect(migrated.wrappedDataKey).not.toBeNull();
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
