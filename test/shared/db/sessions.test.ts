import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { FakeTime } from "@std/testing/time";
import { hashSessionToken } from "#crypto/hashing.ts";
import { execute, executeWithoutCacheInvalidation, getDb } from "#db/client.ts";
import {
  createSession,
  deleteAllSessions,
  deleteOtherSessions,
  deleteSession,
  getAllSessions,
  getSession,
  getSessionWithUser,
} from "#db/sessions.ts";
import { sql } from "#db/sql.ts";
import { createUser } from "#db/users.ts";
import {
  getAllCacheStats,
  invalidateCachesForTable,
  resetAllCaches,
} from "#shared/cache-registry.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

/** Read `token` after its DB row is gone: a cache hit still serves `csrf`,
 *  which is what proves the read never reached the DB. */
const expectCachedAfterRowRemoval = async (token: string, csrf: string) => {
  await executeWithoutCacheInvalidation(sql`DELETE FROM sessions`);
  expect((await getSession(token))?.csrfToken).toBe(csrf);
};

/** Create a session that expires `ttlMs` from now, with the clock frozen at
 *  that instant, and hand the clock to `body` so it can advance time. */
const withFrozenSession = async (
  token: string,
  csrf: string,
  ttlMs: number,
  body: (clock: FakeTime, start: number) => Promise<void>,
) => {
  const start = Date.now();
  using time = new FakeTime(start);
  await createSession(token, csrf, start + ttlMs, null, 1);
  await body(time, start);
};

describeWithEnv("db > sessions", { db: true }, () => {
  test("createSession and getSession work together", async () => {
    const expires = Date.now() + 1000;
    await createSession("test-token", "test-csrf-token", expires, null, 1);

    const session = await getSession("test-token");
    expect(session).not.toBeNull();
    expect(session?.csrfToken).toBe("test-csrf-token");
    expect(session?.expires).toBe(expires);
  });

  test("getSession returns null for missing session", async () => {
    const session = await getSession("nonexistent");
    expect(session).toBeNull();
  });

  test("deleteSession removes session", async () => {
    await createSession("delete-me", "csrf-delete", Date.now() + 1000, null, 1);
    await deleteSession("delete-me");

    const session = await getSession("delete-me");
    expect(session).toBeNull();
  });

  test("deleteAllSessions removes all sessions", async () => {
    await createSession("session1", "csrf1", Date.now() + 10000, null, 1);
    await createSession("session2", "csrf2", Date.now() + 10000, null, 1);
    await createSession("session3", "csrf3", Date.now() + 10000, null, 1);

    await deleteAllSessions();

    const session1 = await getSession("session1");
    const session2 = await getSession("session2");
    const session3 = await getSession("session3");

    expect(session1).toBeNull();
    expect(session2).toBeNull();
    expect(session3).toBeNull();
  });

  test("getAllSessions returns all sessions ordered by expiration descending", async () => {
    const now = Date.now();
    await createSession("session1", "csrf1", now + 1000, null, 1);
    await createSession("session2", "csrf2", now + 3000, null, 1);
    await createSession("session3", "csrf3", now + 2000, null, 1);

    const sessions = await getAllSessions();

    expect(sessions.length).toBe(3);
    expect(sessions[0]?.csrfToken).toBe("csrf2");
    expect(sessions[1]?.csrfToken).toBe("csrf3");
    expect(sessions[2]?.csrfToken).toBe("csrf1");
  });

  test("getAllSessions returns empty array when no sessions", async () => {
    const sessions = await getAllSessions();
    expect(sessions).toEqual([]);
  });

  test("getSessionWithUser reads the session and its user in one call", async () => {
    const user = await createUser("joined-user", "", null, "manager");
    const expires = Date.now() + 1000;
    await createSession("joined", "csrf-joined", expires, null, user.id);

    let found: Awaited<ReturnType<typeof getSessionWithUser>> = null;
    const calls = await countDatabaseCalls(1, async () => {
      found = await getSessionWithUser("joined");
    });

    expect(calls).toBe(1);
    expect(found).toEqual({
      session: {
        csrfToken: "csrf-joined",
        expires,
        token: await hashSessionToken("joined"),
        userId: user.id,
        wrappedDataKey: null,
      },
      user: { adminLevel: user.adminLevel, id: user.id },
    });
  });

  test("getSessionWithUser keeps a session whose user was deleted", async () => {
    const user = await createUser("gone-user", "", null, "manager");
    await createSession(
      "orphan",
      "csrf-orphan",
      Date.now() + 1000,
      null,
      {
        ...user,
      }.id,
    );
    await execute(sql`DELETE FROM users WHERE id = ${user.id}`);

    const found = await getSessionWithUser("orphan");

    // The caller tells this apart from an unknown token: it reports the broken
    // session and clears the row, rather than silently leaving it behind.
    expect(found?.session.csrfToken).toBe("csrf-orphan");
    expect(found?.user).toBeNull();
  });

  test("getSessionWithUser returns null for a token nobody has", async () => {
    expect(await getSessionWithUser("never-issued")).toBeNull();
  });

  test("deleteOtherSessions removes all sessions except current", async () => {
    await createSession("current", "csrf-current", Date.now() + 10000, null, 1);
    await createSession("other1", "csrf-other1", Date.now() + 10000, null, 1);
    await createSession("other2", "csrf-other2", Date.now() + 10000, null, 1);

    await deleteOtherSessions("current");

    const currentSession = await getSession("current");
    const other1 = await getSession("other1");
    const other2 = await getSession("other2");

    expect(currentSession).not.toBeNull();
    expect(other1).toBeNull();
    expect(other2).toBeNull();
  });

  test("deleteOtherSessions with no other sessions keeps current", async () => {
    await createSession("only-session", "csrf", Date.now() + 10000, null, 1);

    await deleteOtherSessions("only-session");

    const session = await getSession("only-session");
    expect(session).not.toBeNull();
  });

  test("getSession expires cached entry after TTL", async () => {
    await withFrozenSession(
      "ttl-test",
      "csrf-ttl",
      60000,
      async (clock, start) => {
        const firstCall = await getSession("ttl-test");
        expect(firstCall).not.toBeNull();

        // Advance time past the 10-second TTL
        clock.now = start + 11000;

        const afterTtl = await getSession("ttl-test");
        expect(afterTtl).not.toBeNull();
        expect(afterTtl?.csrfToken).toBe("csrf-ttl");
      },
    );
  });

  test("getSession does not serve an expired cached session", async () => {
    await withFrozenSession(
      "expired-cache",
      "csrf-expired",
      1000,
      async (clock, start) => {
        await executeWithoutCacheInvalidation(sql`DELETE FROM sessions`);
        clock.now = start + 2000;

        expect(await getSession("expired-cache")).toBeNull();
      },
    );
  });

  // The following tests observe the cache's *effect* by mutating the DB row
  // behind the cache's back: a cached read returns the stale in-memory value,
  // while a cache miss reflects the changed DB.

  test("createSession pre-caches so a later read skips the DB", async () => {
    await createSession("precache", "csrf-pre", Date.now() + 60000, null, 1);
    // With the row gone from the DB, only the cache can answer.
    await expectCachedAfterRowRemoval("precache", "csrf-pre");
  });

  test("getSession caches the DB result so a second read skips the DB", async () => {
    await createSession("dbcache", "csrf-db", Date.now() + 60000, null, 1);
    invalidateCachesForTable("sessions"); // drop the pre-cache; the DB row remains

    // The miss reads the DB and caches it; the second read must not.
    expect((await getSession("dbcache"))?.csrfToken).toBe("csrf-db");
    await expectCachedAfterRowRemoval("dbcache", "csrf-db");
  });

  test("getSession re-queries the DB once the cache TTL expires", async () => {
    await withFrozenSession(
      "ttl-requery",
      "csrf-old",
      60000,
      async (clock, start) => {
        // Within TTL: cached (stale) value is served even after the DB changes.
        await executeWithoutCacheInvalidation(
          sql`UPDATE sessions SET csrf_token = 'csrf-new'`,
        );
        expect((await getSession("ttl-requery"))?.csrfToken).toBe("csrf-old");

        // Midway through the window the entry is still served, so the TTL is a
        // real span of time, not just "the same instant".
        clock.now = start + 5000;
        expect((await getSession("ttl-requery"))?.csrfToken).toBe("csrf-old");

        // Past the 10s TTL: the cache entry expires and the DB is re-read.
        clock.now = start + 11000;
        expect((await getSession("ttl-requery"))?.csrfToken).toBe("csrf-new");
      },
    );
  });

  test("repeated reads of a missing session stay null (cached null is safe)", async () => {
    expect(await getSession("ghost")).toBeNull();
    // Second read hits the cached null entry; must not throw or resurrect a row.
    expect(await getSession("ghost")).toBeNull();
  });

  test("session table invalidation clears cached sessions", async () => {
    await createSession("reset-me", "csrf-reset", Date.now() + 60000, null, 1);
    await executeWithoutCacheInvalidation(sql`DELETE FROM sessions`); // DB empty; cache still holds it

    invalidateCachesForTable("sessions");

    // With the cache cleared, the read falls through to the (empty) DB.
    expect(await getSession("reset-me")).toBeNull();
  });

  test("full resets do not refill the session cache from a stale replica", async () => {
    await createSession(
      "reset-stale",
      "csrf-stale",
      Date.now() + 60000,
      null,
      1,
    );
    const staleReplicaResult = await getDb().execute(
      sql`SELECT token, csrf_token, expires, wrapped_data_key, user_id FROM sessions`,
    );
    await executeWithoutCacheInvalidation(sql`DELETE FROM sessions`);

    using _env = withEnv({ DB_URL: "libsql://replica.test" });
    const replicaRead = stub(getDb(), "execute", () =>
      Promise.resolve(staleReplicaResult),
    );
    try {
      resetAllCaches();
      expect(await getSession("reset-stale")).toBeNull();
    } finally {
      replicaRead.restore();
    }
  });

  test("deleteOtherSessions keeps the current session cached", async () => {
    const expires = Date.now() + 60000;
    await createSession("keep", "csrf-keep", expires, null, 1);
    await createSession("drop", "csrf-drop", expires, null, 1);

    await deleteOtherSessions("keep");

    // The kept session is still cached: with every DB row gone a cached read
    // returns it, while the dropped one is gone.
    await expectCachedAfterRowRemoval("keep", "csrf-keep");
  });

  test("unique invalid tokens cannot grow the session cache without bound", async () => {
    invalidateCachesForTable("sessions");

    // The bound this test pins is the session cache's documented contract:
    // at most 1,000 entries (SESSION_CACHE_MAX_ENTRIES in sessions.ts).
    const cap = 1000;
    const probes = cap + 100;
    for (let i = 0; i < probes; i++) {
      expect(await getSession(`junk-cookie-${i}`)).toBeNull();
    }

    // Exactly the cap: more would mean unbounded growth, fewer would mean
    // the cache holds less than its documented contract.
    const stat = getAllCacheStats().find((s) => s.name === "sessions");
    expect(stat?.entries).toBe(cap);
  });

  test("registers a 'sessions' cache stat reflecting cached entries", async () => {
    invalidateCachesForTable("sessions");
    const before = getAllCacheStats().find((s) => s.name === "sessions");
    expect(before?.entries).toBe(0);

    await createSession("stat", "csrf-stat", Date.now() + 60000, null, 1);
    const after = getAllCacheStats().find((s) => s.name === "sessions");
    expect(after?.entries).toBe(1);
  });
});
