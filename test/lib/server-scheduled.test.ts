/**
 * Tests for the public scheduled-tasks endpoint (POST /scheduled).
 *
 * Auth is a bearer token compared against SCHEDULED_TASKS_KEY. The endpoint
 * runs this site's prune; on a builder, ?built=true also forwards a prune to
 * the least-recently-pruned built site (the outbound call is stubbed here).
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv, mockRequest } from "#test-utils";

const KEY = "cron-secret-key";

/** POST /scheduled, optionally with a bearer token and the built flag. */
const postScheduled = (
  opts: { bearer?: string; built?: boolean } = {},
): Promise<Response> => {
  const headers: Record<string, string> = {};
  if (opts.bearer !== undefined)
    headers.authorization = `Bearer ${opts.bearer}`;
  const path = opts.built ? "/scheduled?built=true" : "/scheduled";
  return handleRequest(mockRequest(path, { headers, method: "POST" }));
};

/** Insert an orphaned attendee created `days` ago (no listing booking). */
const insertOldOrphan = async (days: number): Promise<number> => {
  const created = new Date(nowMs() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await getDb().execute(
    insert("attendees", {
      created,
      pii_blob: "",
      ticket_token_index: `sched-orphan-${crypto.randomUUID()}`,
    }),
  );
  return Number(result.lastInsertRowid);
};

const attendeeExists = async (id: number): Promise<boolean> =>
  (await queryOne<{ one: number }>(
    "SELECT 1 AS one FROM attendees WHERE id = ?",
    [id],
  )) !== null;

const lastPrunedOf = async (siteId: number): Promise<string> =>
  (
    await queryOne<{ last_pruned: string }>(
      "SELECT last_pruned FROM built_sites WHERE id = ?",
      [siteId],
    )
  )?.last_pruned ?? "";

describeWithEnv("server (scheduled tasks): feature off", { db: true }, () => {
  test("404s when SCHEDULED_TASKS_KEY is not configured", async () => {
    const response = await postScheduled({ bearer: "anything" });
    expect(response.status).toBe(404);
    response.body?.cancel();
  });
});

describeWithEnv(
  "server (scheduled tasks): auth",
  { db: true, env: { SCHEDULED_TASKS_KEY: KEY } },
  () => {
    test("401s when no bearer token is supplied", async () => {
      const response = await postScheduled();
      expect(response.status).toBe(401);
      response.body?.cancel();
    });

    test("401s when the bearer token is wrong", async () => {
      const response = await postScheduled({ bearer: "wrong" });
      expect(response.status).toBe(401);
      response.body?.cancel();
    });

    test("runs the prune for a valid key", async () => {
      const orphanId = await insertOldOrphan(365);

      const response = await postScheduled({ bearer: KEY });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual({ forwarded: null, ok: true, pruned: true });
      // Auto-purge is on by default, so the year-old orphan is gone.
      expect(await attendeeExists(orphanId)).toBe(false);
    });
  },
);

describeWithEnv(
  "server (scheduled tasks): built forwarding",
  { db: true, env: { CAN_BUILD_SITES: "true", SCHEDULED_TASKS_KEY: KEY } },
  () => {
    test("forwards a prune to the least-recently-pruned built site", async () => {
      const site = await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok", { status: 200 })),
      );
      try {
        const response = await postScheduled({ bearer: KEY, built: true });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.forwarded).toEqual({
          ok: true,
          site: "client.b-cdn.net",
          status: 200,
        });

        // It called the client's /scheduled with the shared bearer key.
        expect(fetchStub.calls.length).toBe(1);
        const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
        expect(url).toBe("https://client.b-cdn.net/scheduled");
        expect((init.headers as Record<string, string>).authorization).toBe(
          `Bearer ${KEY}`,
        );
        expect(init.method).toBe("POST");

        // The site's rotation stamp was bumped so the next call walks onward.
        expect(await lastPrunedOf(site.id)).not.toBe("");
      } finally {
        fetchStub.restore();
      }
    });

    test("reports forwarded null when the builder has no built sites", async () => {
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok")),
      );
      try {
        const response = await postScheduled({ bearer: KEY, built: true });
        const body = await response.json();
        expect(body.forwarded).toBe(null);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("reports an error when the built site is unreachable", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.reject(new Error("network down")),
      );
      try {
        const response = await postScheduled({ bearer: KEY, built: true });
        const body = await response.json();
        expect(body.forwarded).toEqual({
          error: "network down",
          site: "client.b-cdn.net",
        });
      } finally {
        fetchStub.restore();
      }
    });
  },
);

describeWithEnv(
  "server (scheduled tasks): built ignored when not a builder",
  { db: true, env: { SCHEDULED_TASKS_KEY: KEY } },
  () => {
    test("ignores ?built=true and forwards nothing", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok")),
      );
      try {
        const response = await postScheduled({ bearer: KEY, built: true });
        const body = await response.json();
        expect(body.forwarded).toBe(null);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });
  },
);
