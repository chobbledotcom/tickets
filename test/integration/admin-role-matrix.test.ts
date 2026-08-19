/**
 * Proves the admin surface tells the truth about who can reach each route.
 *
 * Every route the surface declares names the roles that reach it. This walks
 * that declaration and asks each route as every admin role: a role outside the
 * audience must never be served, and a role inside it must never be forbidden.
 * A disagreement here is a real fault — either a link the viewer cannot follow,
 * or a page that serves somebody the surface keeps out.
 *
 * Three kinds of route are asked in the three ways they can answer:
 *
 * - A page taking no parameter answers about the role alone, so both rules are
 *   written about being served (200) and being forbidden (403). A page whose
 *   feature is switched off answers 404 to everybody, which is still a refusal.
 * - A page for one record needs no record to exist: the gate runs before the
 *   lookup, so a role it excludes meets a 403 whether or not the record is
 *   there. The pages that answer 404 instead are named below, with why.
 * - A route that writes is asked with its own method and a valid CSRF token,
 *   so the only thing left to refuse it is its role gate. A role it excludes
 *   is refused before anything is written.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import type { AdminDestinationDef } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import type { AdminLevel } from "#shared/types.ts";
import { ALL_ADMIN_LEVELS } from "#shared/types.ts";
import { oneServedPath } from "#test-utils/admin-surface.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  getTestSession,
} from "#test-utils/session.ts";

const FORBIDDEN = 403;
const GONE = 404;
const SERVED = 200;

const declared = Object.values(ADMIN_SURFACE.destinations);

/** Pages that answer about the role alone, with no record to look up first. */
const roleOnly = declared.filter(
  (destination) => !destination.pattern.includes(":"),
);

/** Pages for one record, where the gate runs before the record is fetched. */
const recordPages = declared.filter((destination) =>
  destination.pattern.includes(":"),
);

/** Building sites needs `CAN_BUILD_SITES`, which is off here, so these two
 * areas are absent for every role and refuse nobody in particular. */
const FEATURE_OFF_AREAS = new Set(["builder", "builtSites"]);

/**
 * Tabs of a record page, and the role each one hides from. The page admits
 * the role — its floor is every role that reaches any of its tabs — and then
 * the tab hides itself, which reads as a page that is not there.
 *
 * Pinned by role, not by page, so a tab that stops hiding itself shows up
 * here rather than passing as some other kind of refusal.
 */
const HIDDEN_TABS = new Set([
  "group:editor",
  "listing:editor",
  "listingAttributes:editor",
  "listingAttributes:manager",
  "listingQr:editor",
  "listingQuestions:editor",
  "listingQuestions:manager",
]);

/**
 * What a route answers a role it excludes: forbidden, or absent when the page
 * is switched off here or the tab hides itself. A hidden tab only hides the
 * page; the write at the same path is its own route with its own gate, so it
 * still refuses outright.
 */
const refusalFor = (
  destination: AdminDestinationDef,
  adminLevel: AdminLevel,
  channel: "page" | "write",
): number =>
  FEATURE_OFF_AREAS.has(destination.area) ||
  (channel === "page" && HIDDEN_TABS.has(`${destination.id}:${adminLevel}`))
    ? GONE
    : FORBIDDEN;

/** Every method and path the admin serves that is not a GET. */
const writeRoutes = async (): Promise<Map<string, string>> => {
  const byPath = new Map<string, string>();
  for (const loader of Object.values(ADMIN_AREA_LOADERS)) {
    for (const route of Object.keys(await loader.load())) {
      const boundary = route.indexOf(" ");
      const method = route.slice(0, boundary);
      if (method !== "GET") byPath.set(route.slice(boundary + 1), method);
    }
  }
  return byPath;
};

describeWithEnv("admin role matrix", { db: true }, () => {
  const cookies = new Map<AdminLevel, string>();
  let methods: Map<string, string>;

  beforeEach(async () => {
    methods = await writeRoutes();
    const owner = await getTestSession();
    cookies.set("owner", owner.cookie);
    cookies.set("manager", await createTestManagerSession());
    cookies.set("editor", (await createTestEditorSession()).cookie);
    cookies.set("agent", (await createTestAgentSession()).cookie);
  });

  const askAs = async (
    path: string,
    adminLevel: AdminLevel,
    method = "GET",
  ): Promise<number> => {
    const { handleRequest } = await import("#routes");
    const headers: Record<string, string> = {
      cookie: cookies.get(adminLevel)!,
      host: "localhost",
    };
    const body =
      method === "GET"
        ? {}
        : {
            body: "unused=1",
            headers: {
              ...headers,
              "content-type": "application/x-www-form-urlencoded",
            },
          };
    const response = await handleRequest(
      new Request(`http://localhost${path}`, { headers, method, ...body }),
    );
    return response.status;
  };

  /** Ask `destination` as every role it does not declare. */
  const askOutsiders = async (
    destinations: readonly AdminDestinationDef[],
    method?: (destination: AdminDestinationDef) => string,
  ): Promise<string[]> => {
    const wrong: string[] = [];
    for (const destination of destinations) {
      for (const adminLevel of ALL_ADMIN_LEVELS) {
        if (destination.audience.includes(adminLevel)) continue;
        const expected = refusalFor(destination, adminLevel, "page");
        const status = await askAs(
          oneServedPath(destination.pattern),
          adminLevel,
          method?.(destination),
        );
        if (status !== expected) {
          wrong.push(
            `${destination.id} (${destination.pattern}) answered ${status} to ${adminLevel}, wanted ${expected}`,
          );
        }
      }
    }
    return wrong;
  };

  test("covers every route the surface declares", () => {
    // Guards the walks below: a surface that stopped declaring its routes
    // would otherwise make this suite pass by testing nothing.
    expect(roleOnly.length).toBe(61);
    expect(recordPages.length).toBe(88);
  });

  test("never serves a page to a role it does not declare", async () => {
    const served: string[] = [];
    for (const destination of roleOnly) {
      for (const adminLevel of ALL_ADMIN_LEVELS) {
        if (destination.audience.includes(adminLevel)) continue;
        const status = await askAs(destination.pattern, adminLevel);
        if (status === SERVED) {
          served.push(
            `${destination.id} (${destination.pattern}) served ${adminLevel}`,
          );
        }
      }
    }
    expect(served).toEqual([]);
  });

  test("never forbids a role the page does declare", async () => {
    const refused: string[] = [];
    for (const destination of [...roleOnly, ...recordPages]) {
      for (const adminLevel of destination.audience) {
        const status = await askAs(
          oneServedPath(destination.pattern),
          adminLevel,
        );
        if (status === FORBIDDEN) {
          refused.push(
            `${destination.id} (${destination.pattern}) refused ${adminLevel}`,
          );
        }
      }
    }
    expect(refused).toEqual([]);
  });

  test("refuses a record page before looking the record up", async () => {
    expect(await askOutsiders(recordPages)).toEqual([]);
  });

  test("refuses a write from a role the route does not declare", async () => {
    // The token is real, so a request that gets past the role gate would go
    // on to do the write. Nothing is written while this passes, and a gate
    // that admits too much shows up as an answer that is not a refusal.
    const { handleRequest } = await import("#routes");
    const csrf = await signCsrfToken();
    const wrong: string[] = [];
    for (const destination of declared) {
      const method = methods.get(destination.pattern);
      if (method === undefined) continue;
      for (const adminLevel of ALL_ADMIN_LEVELS) {
        if (destination.audience.includes(adminLevel)) continue;
        const expected = refusalFor(destination, adminLevel, "write");
        const response = await handleRequest(
          new Request(`http://localhost${oneServedPath(destination.pattern)}`, {
            body: new URLSearchParams({ csrf_token: csrf }).toString(),
            headers: {
              "content-type": "application/x-www-form-urlencoded",
              cookie: cookies.get(adminLevel)!,
              host: "localhost",
            },
            method,
          }),
        );
        if (response.status !== expected) {
          wrong.push(
            `${method} ${destination.pattern} answered ${response.status} to ${adminLevel}, wanted ${expected}`,
          );
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  test("covers the write routes the surface declares", () => {
    const covered = declared.filter((one) => methods.has(one.pattern));
    expect(covered.length).toBe(91);
  });
});

describe("the routes this suite cannot ask", () => {
  test("are the writes at a path no route declares", async () => {
    // A write with no declared path takes its roles from its handler alone,
    // and nothing above compares the two. The count is stated so the gap
    // cannot widen unnoticed.
    const paths = new Set(declared.map((one) => one.pattern));
    const methods = await writeRoutes();
    const undeclared = [...methods.keys()].filter((path) => !paths.has(path));
    expect(undeclared.length).toBe(98);
  });
});
