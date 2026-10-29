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
 * - A route that writes is asked with every method its path serves — a POST
 *   beside a DELETE, and the form page's own GET — each carrying a valid CSRF
 *   token where the method takes a body, so the only thing left to refuse it
 *   is its role gate. A role the declaration excludes is refused before
 *   anything is written or shown.
 */

import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { requiredMapValue } from "#fp";
import { ADMIN_AREA_LOADERS } from "#routes/admin/area-loaders.ts";
import type { AdminDestinationDef } from "#shared/admin-surface/definitions.ts";
import { ADMIN_SURFACE, oneServedPath } from "#shared/admin-surface.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestScannerSession } from "#test-utils/role-sessions.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  getTestSession,
} from "#test-utils/session.ts";
import { type AdminLevel, ALL_ADMIN_LEVELS } from "#types";

const FORBIDDEN = 403;
const GONE = 404;
const SERVED = 200;

const declared = Object.values(ADMIN_SURFACE.destinations);

/** Pages, the destinations the router answers with a GET of their own. A
 * write (a settings sub-form, a reorder move, an image upload, a scan) is its
 * own route with its own gate, and the write walks below ask it with its
 * method. Only views are walked as pages. */
const pages = declared.filter((destination) => destination.intent === "view");

/** Pages that answer about the role alone, with no record to look up first. */
const roleOnly = pages.filter(
  (destination) => !destination.pattern.includes(":"),
);

/** Pages for one record, where the gate runs before the record is fetched. */
const recordPages = pages.filter((destination) =>
  destination.pattern.includes(":"),
);

/** Building sites needs `CAN_BUILD_SITES`, which is off here, so these two
 * areas are absent for every role and refuse nobody in particular. */
const FEATURE_OFF_AREAS = new Set(["builder", "builtSites"]);

/** What a route answers a role it excludes: forbidden, or absent when the
 * page is switched off here. */
const refusalFor = (
  destination: AdminDestinationDef,
  _adminLevel: AdminLevel,
  _channel: "page" | "write",
): number => (FEATURE_OFF_AREAS.has(destination.area) ? GONE : FORBIDDEN);

/** Every method the admin serves at each path, GET included. A write (a
 * settings sub-form, a reorder move, an image upload, a scan) is its own
 * route with its own gate, and the write walks below ask it with every method
 * its path serves — a path can carry a POST beside a DELETE (the confirmed
 * deletes do), and each method's gate is its own. Only views are walked as
 * pages. */
const servedMethods = async (): Promise<Map<string, string[]>> => {
  const byPath = new Map<string, string[]>();
  for (const loader of Object.values(ADMIN_AREA_LOADERS)) {
    for (const route of Object.keys(await loader.load())) {
      const boundary = route.indexOf(" ");
      const method = route.slice(0, boundary);
      const path = route.slice(boundary + 1);
      byPath.set(path, [...(byPath.get(path) ?? []), method]);
    }
  }
  return byPath;
};

describeWithEnv("admin role matrix", { db: true }, () => {
  const cookies = new Map<AdminLevel, string>();
  let methods: Map<string, string[]>;

  beforeEach(async () => {
    methods = await servedMethods();
    const owner = await getTestSession();
    cookies.set("owner", owner.cookie);
    cookies.set("manager", await createTestManagerSession());
    cookies.set("editor", (await createTestEditorSession()).cookie);
    cookies.set("agent", (await createTestAgentSession()).cookie);
    cookies.set("scanner", (await createTestScannerSession()).cookie);
  });

  /** Ask one path as one role. A write carries a real CSRF token, so the role
   * gate is the only thing left that can refuse it. */
  const askAs = async (
    path: string,
    adminLevel: AdminLevel,
    method = "GET",
  ): Promise<number> => {
    const { handleRequest } = await import("#routes");
    const headers: Record<string, string> = {
      cookie: requiredMapValue(
        cookies,
        adminLevel,
        `No session for ${adminLevel}`,
      ),
      host: "localhost",
    };
    if (method === "GET") {
      const read = new Request(`http://localhost${path}`, { headers });
      return (await handleRequest(read)).status;
    }
    headers["content-type"] = "application/x-www-form-urlencoded";
    const write = new Request(`http://localhost${path}`, {
      body: new URLSearchParams({
        csrf_token: await signCsrfToken(),
      }).toString(),
      headers,
      method,
    });
    return (await handleRequest(write)).status;
  };

  /** The roles a route keeps out. */
  const outsidersOf = (destination: AdminDestinationDef): AdminLevel[] =>
    ALL_ADMIN_LEVELS.filter((level) => !destination.audience.includes(level));

  /** The methods a route's own path serves, GET included. A declaration can
   * spell a path's parameters differently from the route (the check-in page
   * does), so only an exact path is askable by method; the manifest proves
   * every declaration is served some other way. */
  const methodsOf = (destination: AdminDestinationDef): readonly string[] =>
    methods.get(destination.pattern) ?? [];

  /** Ask one route as every role it keeps out, reporting each answer that was
   * not the refusal that route owes them. Every method the path serves is
   * asked: a POST beside a DELETE carries two gates, and each must refuse. */
  const refusalsOf = async (
    destination: AdminDestinationDef,
    methodList: readonly string[] = methodsOf(destination),
  ): Promise<string[]> => {
    const path = oneServedPath(destination.pattern);
    const wrong: string[] = [];
    for (const method of methodList) {
      for (const adminLevel of outsidersOf(destination)) {
        const expected = refusalFor(destination, adminLevel, "write");
        const status = await askAs(path, adminLevel, method);
        if (status !== expected) {
          wrong.push(
            `${method} ${destination.pattern} answered ${status} to ${adminLevel}, wanted ${expected}`,
          );
        }
      }
    }
    return wrong;
  };

  /** The declared routes that also take a write at their own path. */
  const writableRoutes = (): AdminDestinationDef[] =>
    declared.filter((one) => methodsOf(one).some((method) => method !== "GET"));

  /** The JSON scanner APIs, whose Content-Type middleware answers 400 before
   * the role gate runs — this suite's form body can neither be admitted nor
   * refused by the role, so the gates are proved by the scanner feature
   * suite instead of here. */
  const JSON_API_WRITE_IDS = new Set(["groupScan", "listingScan"]);

  /** The same routes, less the ones this suite cannot ask: the session-ending
   * logout, and the JSON scanner APIs. Asking `POST /admin/logout` as a role
   * it admits succeeds, and every later request in that walk is then signed
   * out. Logging out is proved by
   * `test/features/admin/auth/logout.test.ts`. */
  const insiderWritableRoutes = (): AdminDestinationDef[] =>
    writableRoutes().filter(
      (one) => one.id !== "logout" && !JSON_API_WRITE_IDS.has(one.id),
    );

  /** The write methods the walks ask: one pair per method each writable
   * route's path serves, GET left out. */
  const writeMethodPairs = (): number =>
    writableRoutes().reduce(
      (count, one) =>
        count + methodsOf(one).filter((method) => method !== "GET").length,
      0,
    );

  /** The writable routes whose GET serves a page at the same path: a write's
   * own form page, or a view page whose POST the walks ask. The declaration
   * governs that GET like the write, so the walks below ask both. */
  const formPageRoutes = (): AdminDestinationDef[] =>
    insiderWritableRoutes().filter((one) => methodsOf(one).includes("GET"));

  /** Ask one route as every role it admits, reporting each answer that
   * forbids them. */
  const admissionsOf = async (
    destination: AdminDestinationDef,
    methodList: readonly string[],
  ): Promise<string[]> => {
    const path = oneServedPath(destination.pattern);
    const refused: string[] = [];
    for (const method of methodList) {
      for (const adminLevel of destination.audience) {
        const status = await askAs(path, adminLevel, method);
        if (status === FORBIDDEN) {
          refused.push(
            `${method} ${destination.pattern} refused ${adminLevel}`,
          );
        }
      }
    }
    return refused;
  };

  const askOutsiders = async (
    destinations: readonly AdminDestinationDef[],
    methodList?: readonly string[],
  ): Promise<string[]> => {
    const wrong: string[] = [];
    for (const destination of destinations) {
      wrong.push(...(await refusalsOf(destination, methodList)));
    }
    return wrong;
  };

  test("covers every route the surface declares", () => {
    // Guards the walks below: a surface that stopped declaring its routes
    // would otherwise make this suite pass by testing nothing.
    // The scanner's ticket-cache reads are record routes like their scanner
    // pages: the gate runs before the record lookup, so the matrix walks them.
    expect(roleOnly.length).toBe(50);
    expect(recordPages.length).toBe(29);
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
    // A record page is asked with GET only: its write methods belong to the
    // write walks below.
    expect(await askOutsiders(recordPages, ["GET"])).toEqual([]);
  });

  test("refuses a write from a role the route does not declare", async () => {
    // The token is real, so a request that gets past the role gate would go
    // on to do the write. Nothing is written while this passes, and a gate
    // that admits too much shows up as an answer that is not a refusal.
    // Every method the path serves is asked, so a DELETE beside a POST
    // cannot carry a gate the surface never saw.
    const wrong = await askOutsiders(
      writableRoutes().filter((one) => !JSON_API_WRITE_IDS.has(one.id)),
    );
    expect(wrong).toEqual([]);
  });

  test("never refuses a write from a role the route does declare", async () => {
    // The mirror of the walk above. Without it a handler could answer 403 to
    // every role, and the refusal walk would still pass while the route was
    // reachable by nobody. What the write then does is each feature's own
    // suite to prove; here the question is only whether the gate let it in.
    const refused: string[] = [];
    for (const destination of insiderWritableRoutes()) {
      refused.push(
        ...(await admissionsOf(destination, [...methodsOf(destination)])),
      );
    }
    expect(refused).toEqual([]);
  });

  test("covers the write routes the surface declares", () => {
    expect(writableRoutes().length).toBe(199);
    expect(insiderWritableRoutes().length).toBe(196);
    // The DELETE beside the confirmed POST deletes: each method's gate is
    // its own, so the walks above must ask both.
    expect(writeMethodPairs()).toBe(201);
    // The writable routes whose GET serves a page at the same path — a
    // write's own form page, or a view page whose POST the walks ask too.
    // The refusal walk asks those GETs like the writes, so this pins their
    // number too.
    expect(formPageRoutes().length).toBe(79);
  });
});

describe("the routes this suite cannot ask", () => {
  test("are the writes at a path no route declares", async () => {
    // A write with no declared path takes its roles from its handler alone,
    // and nothing above compares the two. Every write now declares a path, so
    // the gap cannot widen unnoticed.
    const paths = new Set(declared.map((one) => one.pattern));
    const served = await servedMethods();
    const undeclared = [...served.entries()]
      .filter(
        ([path, servedMethods]) =>
          servedMethods.some((method) => method !== "GET") && !paths.has(path),
      )
      .map(([path]) => path);
    expect(undeclared).toEqual([]);
  });
});
