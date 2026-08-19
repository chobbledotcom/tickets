/**
 * Admin request dispatch: unknown segments stop before any session work, a
 * segment's router is reusable once built, the gate that decides whether a
 * request needs a session lets exactly the right paths through without one,
 * and only staff get the footer that exposes the query log.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import {
  createTestEditorSession,
  getTestSession,
} from "#test-utils/session.ts";

const bodyOf = async (path: string, cookie: string): Promise<string> => {
  const response = await awaitTestRequest(path, { cookie });
  expect(response.status, path).toBe(200);
  return await response.text();
};

describeWithEnv("admin segment dispatch", { db: true }, () => {
  test("a path under no declared segment gets a 404", async () => {
    const response = await awaitTestRequest("/admin/no-such-area");
    expect(response.status).toBe(404);
  });

  test("a repeat hit on a settings segment succeeds twice", async () => {
    // A segment builds its router once and keeps it. Both hits must be signed
    // in: a signed-out one is refused before the router is ever built, so it
    // would pass whether or not the second hit can reuse the first's router.
    const { cookie } = await getTestSession();
    const first = await awaitTestRequest("/admin/settings", { cookie });
    const second = await awaitTestRequest("/admin/settings", { cookie });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  test("a signed-out visitor is sent back to /admin", async () => {
    const response = await awaitTestRequest("/admin/settings");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/admin");
  });

  test("a signed-out visitor still reaches the login pages", async () => {
    // These two segments are how somebody signs in, so they must answer
    // without a session rather than send the visitor back to themselves.
    for (const path of ["/admin/", "/admin/login"]) {
      const response = await awaitTestRequest(path);
      expect(response.status, path).toBe(200);
    }
  });

  test("a signed-out check-in is refused as JSON, not redirected", async () => {
    // The scanner posts check-ins here and reads the answer as JSON, so this
    // path must skip the redirect every other signed-out page gets.
    const response = await handleRequest(
      new Request("http://localhost/admin/listing/1/scan", {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json", host: "localhost" },
        method: "POST",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  test("a signed-in visitor reaches a protected page", async () => {
    const { cookie } = await getTestSession();
    const response = await awaitTestRequest("/admin/users", { cookie });
    expect(response.status).toBe(200);
  });
});

describeWithEnv("the admin footer's query log", { db: true }, () => {
  test("opens for staff reading a page", async () => {
    const { cookie } = await getTestSession();
    expect(await bodyOf("/admin/users", cookie)).toContain("debug-menu");
  });

  test("stays shut for an editor", async () => {
    // The log exposes every query the page ran; only staff may read it.
    const { cookie } = await createTestEditorSession();
    expect(await bodyOf("/admin/listings", cookie)).not.toContain("debug-menu");
  });
});
