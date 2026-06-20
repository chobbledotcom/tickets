/**
 * Tests for the maintenance-ping endpoint (GET/POST /scheduled).
 *
 * Pruning runs as interval-gated pending work on every request, so hitting
 * /scheduled (like any request) prunes this site — no auth needed. The one
 * privileged action is the builder fleet-walk: on a builder, POST /scheduled
 * pokes the least-recently-poked built site with a plain GET (stubbed here) to
 * trigger its prune, and that is gated behind the master-only
 * SCHEDULED_TASKS_KEY bearer token. The response never echoes a client
 * hostname.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv, mockRequest } from "#test-utils";

const SECRET = "fleet-walk-secret";

/** GET or POST /scheduled, optionally bearer-authenticated. */
const scheduled = (method: "GET" | "POST", key?: string): Promise<Response> => {
  const headers = key ? { authorization: `Bearer ${key}` } : undefined;
  return handleRequest(mockRequest("/scheduled", { headers, method }));
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

const stubOkFetch = () =>
  stub(globalThis, "fetch", () =>
    Promise.resolve(new Response("ok", { status: 200 })),
  );

describeWithEnv("server (scheduled tasks): public ping", { db: true }, () => {
  test("GET prunes this site and never walks", async () => {
    const orphanId = await insertOldOrphan(365);

    const response = await scheduled("GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, poked: null });
    // Per-request pruning (auto-purge on by default) reaped the year-old orphan.
    expect(await attendeeExists(orphanId)).toBe(false);
  });

  test("POST is an unauthenticated ping when not a builder", async () => {
    const fetchStub = stubOkFetch();
    try {
      const response = await scheduled("POST");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, poked: null });
      expect(fetchStub.calls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
  });
});

describeWithEnv(
  "server (scheduled tasks): builder fleet-walk",
  { db: true, env: { CAN_BUILD_SITES: "true", SCHEDULED_TASKS_KEY: SECRET } },
  () => {
    test("an authenticated POST pokes the next built site with a GET", async () => {
      const site = await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stubOkFetch();
      try {
        const response = await scheduled("POST", SECRET);

        expect(response.status).toBe(200);
        // No client hostname in the response — callers can't enumerate sites.
        expect((await response.json()).poked).toEqual({
          ok: true,
          status: 200,
        });

        // It poked the client's /scheduled with a plain unauthenticated GET.
        expect(fetchStub.calls.length).toBe(1);
        const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
        expect(url).toBe("https://client.b-cdn.net/scheduled");
        expect(init.method).toBe("GET");
        expect(init.headers).toBeUndefined();
        // Redirects are followed only after SSRF re-validation, never blindly.
        expect(init.redirect).toBe("manual");

        // The rotation stamp was bumped so the next walk steps onward.
        expect(await lastPrunedOf(site.id)).not.toBe("");
      } finally {
        fetchStub.restore();
      }
    });

    test("a POST without the key is rejected but still self-prunes", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const orphanId = await insertOldOrphan(365);
      const fetchStub = stubOkFetch();
      try {
        const response = await scheduled("POST");

        expect(response.status).toBe(401);
        expect(fetchStub.calls.length).toBe(0);
        // The gate blocks the walk, not this site's own per-request prune.
        expect(await attendeeExists(orphanId)).toBe(false);
      } finally {
        fetchStub.restore();
      }
    });

    test("a POST with the wrong key is rejected", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stubOkFetch();
      try {
        const response = await scheduled("POST", "wrong-key");
        expect(response.status).toBe(401);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("GET stays a public ping and never walks", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stubOkFetch();
      try {
        const response = await scheduled("GET");
        expect(response.status).toBe(200);
        expect((await response.json()).poked).toBe(null);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("an authenticated POST reports null when there are no built sites", async () => {
      const fetchStub = stubOkFetch();
      try {
        const response = await scheduled("POST", SECRET);
        expect((await response.json()).poked).toBe(null);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("an unreachable built site is reported without leaking its hostname", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.reject(new Error("network down")),
      );
      try {
        const response = await scheduled("POST", SECRET);
        expect((await response.json()).poked).toEqual({ failed: true });
      } finally {
        fetchStub.restore();
      }
    });
  },
);

describeWithEnv(
  "server (scheduled tasks): builder without a key",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("the fleet-walk is disabled — POST is rejected", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stubOkFetch();
      try {
        // Even presenting a bearer can't authenticate when no key is configured.
        const response = await scheduled("POST", SECRET);
        expect(response.status).toBe(401);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });
  },
);
