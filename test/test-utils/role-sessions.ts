/**
 * The user-row and session mechanics the restricted-role session helpers
 * share: insert a user and open a live session for it, the keyed-role factory
 * that wraps the shared data key, and the door-only `scanner` helper.
 */

import type { InValue } from "@libsql/client";
import type { WrappedKey } from "#crypto/sealed.ts";
import { getSessionCookieName } from "#shared/cookies.ts";
import type { AdminLevel } from "#types";

/** Insert a user row and open a live session for it. The role helpers differ
 * only in the row they store and the key the session carries. */
export const createUserWithSession = async (
  username: string,
  row: Record<string, InValue>,
  session: {
    token: string;
    csrfToken: string;
    wrappedKey: WrappedKey | null;
  },
): Promise<number> => {
  const { getDb, insert } = await import("#db/client.ts");
  const { createSession } = await import("#db/sessions.ts");
  const { getUserByUsername, invalidateUsersCache: invalidateUsers } =
    await import("#db/users.ts");
  await getDb().execute(insert("users", row));
  invalidateUsers();
  const userId = (await getUserByUsername(username))!.id;
  await createSession(
    session.token,
    session.csrfToken,
    Date.now() + 60_000,
    session.wrappedKey,
    userId,
  );
  return userId;
};

/** The keyed-role session the manager and scanner helpers share: a user row
 * and a live session that both carry the shared data key, with no password
 * set (the stored shape of an account whose login flow is not being
 * exercised). The agent helper keeps its own row builder because it derives a
 * password-bound key. */
export const createKeyedRoleSession = async (
  role: AdminLevel,
  named: { csrfToken: string; token: string; username: string },
): Promise<{ cookie: string; userId: number }> => {
  const { encrypt: enc } = await import("#crypto/encryption.ts");
  const { hmacHash } = await import("#crypto/hashing.ts");
  const { wrapKeyWithToken } = await import("#crypto/keys.ts");
  const { getOwnerDataKey } = await import("#test-utils/owner-key.ts");

  const dataKey = await getOwnerDataKey();
  const userId = await createUserWithSession(
    named.username,
    {
      admin_level: await enc(role),
      password_hash: "",
      username_hash: await enc(named.username),
      username_index: await hmacHash(named.username),
      wrapped_data_key: await wrapKeyWithToken(dataKey, "user-key-placeholder"),
    },
    {
      csrfToken: named.csrfToken,
      token: named.token,
      wrappedKey: await wrapKeyWithToken(dataKey, named.token),
    },
  );
  return { cookie: `${getSessionCookieName()}=${named.token}`, userId };
};

/**
 * Create a scanner-class user that shares the test data key, plus a live
 * session for it. A scanner decrypts attendee names at the door, so — like
 * staff and agents — both the user row and the session carry a wrapped key.
 */
export const createTestScannerSession = async (
  opts: { token?: string; username?: string } = {},
): Promise<{ cookie: string; userId: number }> =>
  createKeyedRoleSession("scanner", {
    csrfToken: "scanner-csrf",
    token: opts.token ?? "scanner-session",
    // Lower-cased for the same reason as the manager and agent helpers: the
    // login lookup hashes lower-cased, so the stored index must match.
    username: (opts.username ?? "testscanner").toLowerCase(),
  });
