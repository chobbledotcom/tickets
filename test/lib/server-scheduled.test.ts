/**
 * Tests for the public maintenance-ping endpoint (GET/POST /scheduled).
 *
 * Pruning runs as interval-gated pending work on every request, so hitting
 * /scheduled (like any request) prunes this site. On a builder, POST /scheduled
 * also pokes the least-recently-poked built site with a plain GET to trigger
 * its prune (the outbound call is stubbed here). There is no auth: the only
 * side effects are interval-gated prunes of already-expired data.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { insertBuiltSite } from "#shared/db/built-sites.ts";
import { getDb, insert, queryOne } from "#shared/db/client.ts";
import { nowMs } from "#shared/now.ts";
import { describeWithEnv, mockRequest } from "#test-utils";

/** GET or POST /scheduled. */
const scheduled = (method: "GET" | "POST"): Promise<Response> =>
  handleRequest(mockRequest("/scheduled", { method }));

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

describeWithEnv("server (scheduled tasks): self-prune", { db: true }, () => {
  test("pinging /scheduled prunes this site", async () => {
    const orphanId = await insertOldOrphan(365);

    const response = await scheduled("GET");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, poked: null });
    // Per-request pruning (auto-purge on by default) reaped the year-old orphan.
    expect(await attendeeExists(orphanId)).toBe(false);
  });

  test("needs no auth — a bare POST is accepted", async () => {
    const response = await scheduled("POST");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, poked: null });
  });
});

describeWithEnv(
  "server (scheduled tasks): built forwarding",
  { db: true, env: { CAN_BUILD_SITES: "true" } },
  () => {
    test("POST pokes the least-recently-poked built site with a GET", async () => {
      const site = await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok", { status: 200 })),
      );
      try {
        const response = await scheduled("POST");

        expect(response.status).toBe(200);
        const body = await response.json();
        // No client hostname in the response — this endpoint is public.
        expect(body.poked).toEqual({ ok: true, status: 200 });

        // It poked the client's /scheduled with a plain unauthenticated GET.
        expect(fetchStub.calls.length).toBe(1);
        const [url, init] = fetchStub.calls[0]!.args as [string, RequestInit];
        expect(url).toBe("https://client.b-cdn.net/scheduled");
        expect(init.method).toBe("GET");
        expect(init.headers).toBeUndefined();
        // Redirects are followed only after SSRF re-validation, never blindly.
        expect(init.redirect).toBe("manual");

        // The site's rotation stamp was bumped so the next call walks onward.
        expect(await lastPrunedOf(site.id)).not.toBe("");
      } finally {
        fetchStub.restore();
      }
    });

    test("GET does not walk the fleet", async () => {
      await insertBuiltSite("Client", "client.b-cdn.net");
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok")),
      );
      try {
        const response = await scheduled("GET");
        expect((await response.json()).poked).toBe(null);
        expect(fetchStub.calls.length).toBe(0);
      } finally {
        fetchStub.restore();
      }
    });

    test("reports poked null when the builder has no built sites", async () => {
      const fetchStub = stub(globalThis, "fetch", () =>
        Promise.resolve(new Response("ok")),
      );
      try {
        const response = await scheduled("POST");
        expect((await response.json()).poked).toBe(null);
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
        const response = await scheduled("POST");
        // The failure is reported without leaking the client hostname.
        expect((await response.json()).poked).toEqual({ failed: true });
      } finally {
        fetchStub.restore();
      }
    });
  },
);

describeWithEnv("server (scheduled tasks): not a builder", { db: true }, () => {
  test("POST does not poke built sites when not a builder", async () => {
    await insertBuiltSite("Client", "client.b-cdn.net");
    const fetchStub = stub(globalThis, "fetch", () =>
      Promise.resolve(new Response("ok")),
    );
    try {
      const response = await scheduled("POST");
      expect((await response.json()).poked).toBe(null);
      expect(fetchStub.calls.length).toBe(0);
    } finally {
      fetchStub.restore();
    }
  });
});
