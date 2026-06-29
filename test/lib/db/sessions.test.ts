import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { getAllCacheStats } from "#shared/cache-registry.ts";
import { execute } from "#shared/db/client.ts";
import {
  createSession,
  deleteAllSessions,
  deleteOtherSessions,
  deleteSession,
  getAllSessions,
  getSession,
  resetSessionCache,
} from "#shared/db/sessions.ts";
import { describeWithEnv } from "#test-utils";

describeWithEnv("db > sessions", { db: true }, () => {
  test("createSession and getSession work together", async () => {
    const expires = Date.now() + 1000;
    await createSession("test-token", "test-csrf-token", expires, null, 1);

    const session = await getSession("test-token");
    expect(session).not.toBeNull();
    expect(session?.csrf_token).toBe("test-csrf-token");
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
    expect(sessions[0]?.csrf_token).toBe("csrf2");
    expect(sessions[1]?.csrf_token).toBe("csrf3");
    expect(sessions[2]?.csrf_token).toBe("csrf1");
  });

  test("getAllSessions returns empty array when no sessions", async () => {
    const sessions = await getAllSessions();
    expect(sessions).toEqual([]);
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
    const startTime = Date.now();
    const time = new FakeTime(startTime);

    try {
      await createSession("ttl-test", "csrf-ttl", startTime + 60000, null, 1);
      const firstCall = await getSession("ttl-test");
      expect(firstCall).not.toBeNull();

      // Advance time past the 10-second TTL
      time.now = startTime + 11000;

      const afterTtl = await getSession("ttl-test");
      expect(afterTtl).not.toBeNull();
      expect(afterTtl?.csrf_token).toBe("csrf-ttl");
    } finally {
      time.restore();
    }
  });

  // The following tests observe the cache's *effect* by mutating the DB row
  // behind the cache's back: a cached read returns the stale in-memory value,
  // while a cache miss reflects the changed DB.

  test("createSession pre-caches so a later read skips the DB", async () => {
    await createSession("precache", "csrf-pre", Date.now() + 60000, null, 1);
    // Remove the row from the DB; the cache still holds the session.
    await execute("DELETE FROM sessions");

    const session = await getSession("precache");
    expect(session).not.toBeNull();
    expect(session?.csrf_token).toBe("csrf-pre");
  });

  test("getSession caches the DB result so a second read skips the DB", async () => {
    await createSession("dbcache", "csrf-db", Date.now() + 60000, null, 1);
    resetSessionCache(); // drop the pre-cache; the DB row remains

    const first = await getSession("dbcache"); // cache miss → DB → caches
    expect(first?.csrf_token).toBe("csrf-db");

    await execute("DELETE FROM sessions"); // remove DB row; cache retains it
    const second = await getSession("dbcache");
    expect(second).not.toBeNull();
    expect(second?.csrf_token).toBe("csrf-db");
  });

  test("getSession re-queries the DB once the cache TTL expires", async () => {
    const start = Date.now();
    const time = new FakeTime(start);
    try {
      await createSession("ttl-requery", "csrf-old", start + 60000, null, 1);
      // Within TTL: cached (stale) value is served even after the DB changes.
      await execute("UPDATE sessions SET csrf_token = 'csrf-new'");
      expect((await getSession("ttl-requery"))?.csrf_token).toBe("csrf-old");

      // Past the 10s TTL: the cache entry expires and the DB is re-read.
      time.now = start + 11000;
      expect((await getSession("ttl-requery"))?.csrf_token).toBe("csrf-new");
    } finally {
      time.restore();
    }
  });

  test("repeated reads of a missing session stay null (cached null is safe)", async () => {
    expect(await getSession("ghost")).toBeNull();
    // Second read hits the cached null entry; must not throw or resurrect a row.
    expect(await getSession("ghost")).toBeNull();
  });

  test("resetSessionCache clears cached sessions", async () => {
    await createSession("reset-me", "csrf-reset", Date.now() + 60000, null, 1);
    await execute("DELETE FROM sessions"); // DB empty; cache still holds it

    resetSessionCache();

    // With the cache cleared, the read falls through to the (empty) DB.
    expect(await getSession("reset-me")).toBeNull();
  });

  test("deleteOtherSessions keeps the current session cached", async () => {
    const expires = Date.now() + 60000;
    await createSession("keep", "csrf-keep", expires, null, 1);
    await createSession("drop", "csrf-drop", expires, null, 1);

    await deleteOtherSessions("keep");

    // The kept session should still be cached: deleting all DB rows leaves a
    // cached read returning it, while the dropped one is gone.
    await execute("DELETE FROM sessions");
    const kept = await getSession("keep");
    expect(kept).not.toBeNull();
    expect(kept?.csrf_token).toBe("csrf-keep");
  });

  test("registers a 'sessions' cache stat reflecting cached entries", async () => {
    resetSessionCache();
    const before = getAllCacheStats().find((s) => s.name === "sessions");
    expect(before?.entries).toBe(0);

    await createSession("stat", "csrf-stat", Date.now() + 60000, null, 1);
    const after = getAllCacheStats().find((s) => s.name === "sessions");
    expect(after?.entries).toBe(1);
  });
});
