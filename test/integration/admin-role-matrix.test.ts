/**
 * Proves the admin surface tells the truth about who can reach each page.
 *
 * Every page the navigation can link to declares the roles that reach it. This
 * walks that declaration and asks each page as every admin role: a role outside
 * the audience must never be served the page, and a role inside it must never
 * be forbidden. A disagreement here is a real fault — either a link the viewer
 * cannot follow, or a page that serves somebody the surface keeps out.
 *
 * A page can answer a role it admits with a 404 when the feature that owns it
 * is switched off in this environment. That is still a refusal, so the two
 * rules below are written about being served (200) and being forbidden (403)
 * rather than about one exact status.
 *
 * Scope: the pages whose pattern takes no parameter, so the answer is about the
 * role alone. A page for one record answers 404 when the record is absent,
 * which says nothing about permission, so those pages need their own fixtures
 * and are not covered here.
 */

import { expect } from "@std/expect";
import { beforeEach, it as test } from "@std/testing/bdd";
import { ADMIN_SURFACE } from "#shared/admin-surface.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  getTestSession,
} from "#test-utils/session.ts";
import { type AdminLevel, ALL_ADMIN_LEVELS } from "#types";

const FORBIDDEN = 403;
const SERVED = 200;

/** Pages that answer about the role alone, with no record to look up first. */
const roleOnlyDestinations = Object.values(ADMIN_SURFACE.destinations).filter(
  (destination) => !destination.pattern.includes(":"),
);

describeWithEnv("admin role matrix", { db: true }, () => {
  const cookies = new Map<AdminLevel, string>();

  beforeEach(async () => {
    const owner = await getTestSession();
    cookies.set("owner", owner.cookie);
    cookies.set("manager", await createTestManagerSession());
    cookies.set("editor", (await createTestEditorSession()).cookie);
    cookies.set("agent", (await createTestAgentSession()).cookie);
  });

  const askAs = async (
    path: string,
    adminLevel: AdminLevel,
  ): Promise<number> => {
    const { handleRequest } = await import("#routes");
    const response = await handleRequest(
      new Request(`http://localhost${path}`, {
        headers: { cookie: cookies.get(adminLevel)!, host: "localhost" },
      }),
    );
    return response.status;
  };

  test("covers every parameter-free page the surface declares", () => {
    // Guards the walk below: a surface that stopped declaring its pages would
    // otherwise make this suite pass by testing nothing. The split is stated
    // exactly so the plan cannot claim wider cover than this suite has.
    const all = Object.values(ADMIN_SURFACE.destinations);
    expect(roleOnlyDestinations.length).toBe(48);
    expect(all.length - roleOnlyDestinations.length).toBe(63);
  });

  test("never serves a page to a role it does not declare", async () => {
    const served: string[] = [];
    for (const destination of roleOnlyDestinations) {
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
    for (const destination of roleOnlyDestinations) {
      for (const adminLevel of destination.audience) {
        const status = await askAs(destination.pattern, adminLevel);
        if (status === FORBIDDEN) {
          refused.push(
            `${destination.id} (${destination.pattern}) refused ${adminLevel}`,
          );
        }
      }
    }
    expect(refused).toEqual([]);
  });
});
