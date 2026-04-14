import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  createSession,
  deleteAllSessions,
  deleteOtherSessions,
  deleteSession,
  getAllSessions,
  getSession,
} from "#lib/db/sessions.ts";
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
    await createSession(
      "delete-me",
      "csrf-delete",
      Date.now() + 1000,
      null,
      1,
    );
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
    await createSession(
      "current",
      "csrf-current",
      Date.now() + 10000,
      null,
      1,
    );
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
});
