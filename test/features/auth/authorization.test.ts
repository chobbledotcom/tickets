import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { AuthSession } from "#routes/auth.ts";
import {
  requireContentOr,
  requireDeliveryOr,
  requireOwnerOr,
  requireSessionOr,
  requireSiteOr,
  withSession,
} from "#routes/auth.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  testCookie,
} from "#test-utils/session.ts";

/** A session guard: authenticates, checks role, and either runs the handler
 *  with the session or returns an auth-failure response. */
type Guard = (
  request: Request,
  handler: (session: AuthSession) => Response,
) => Promise<Response>;

const EVERY_GUARD: Guard[] = [
  requireOwnerOr,
  requireSessionOr,
  requireContentOr,
  requireSiteOr,
  requireDeliveryOr,
];

/** A live, authenticated cookie for each admin level. */
const roleCookies = async (): Promise<Record<string, string>> => ({
  agent: (await createTestAgentSession()).cookie,
  editor: (await createTestEditorSession()).cookie,
  manager: await createTestManagerSession(),
  owner: await testCookie(),
});

/** Run a guard and return its response. The handler only fires when the guard
 *  admits the request, and returns 200 only when handed a real session (so a
 *  guard that forwarded `undefined` is caught, not silently accepted). */
const runGuard = (guard: Guard, cookie?: string): Promise<Response> =>
  guard(
    new Request(
      "http://localhost/admin/x",
      cookie ? { headers: { cookie } } : undefined,
    ),
    (session) => new Response("OK", { status: session ? 200 : 500 }),
  );

/** Assert a guard admits exactly `allowed` and forbids every other role. Every
 *  cookie is a valid session, so a rejection is a 403 forbidden, never the
 *  not-authenticated redirect. */
const expectAdmits = async (
  guard: Guard,
  cookies: Record<string, string>,
  allowed: string[],
): Promise<void> => {
  for (const [role, cookie] of Object.entries(cookies)) {
    expect((await runGuard(guard, cookie)).status).toBe(
      allowed.includes(role) ? 200 : 403,
    );
  }
};

describeWithEnv("auth authorization matrix", { db: true }, () => {
  test("requireOwnerOr admits only the owner", async () => {
    await expectAdmits(requireOwnerOr, await roleCookies(), ["owner"]);
  });

  test("requireSessionOr (no role) admits only staff (owner, manager)", async () => {
    await expectAdmits(requireSessionOr, await roleCookies(), [
      "owner",
      "manager",
    ]);
  });

  test("requireContentOr admits content editors (owner, manager, editor), not agents", async () => {
    await expectAdmits(requireContentOr, await roleCookies(), [
      "owner",
      "manager",
      "editor",
    ]);
  });

  test("requireSiteOr admits site editors (owner, editor), not managers or agents", async () => {
    await expectAdmits(requireSiteOr, await roleCookies(), ["owner", "editor"]);
  });

  test("requireDeliveryOr admits delivery roles (owner, manager, agent), not editors", async () => {
    await expectAdmits(requireDeliveryOr, await roleCookies(), [
      "owner",
      "manager",
      "agent",
    ]);
  });

  test("every guard redirects an unauthenticated request instead of running the handler", async () => {
    for (const guard of EVERY_GUARD) {
      const response = await runGuard(guard); // no cookie
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    }
  });

  test("withSession runs the handler with the session, or the fallback when absent", async () => {
    const cookie = await testCookie();
    const authed = await withSession(
      new Request("http://localhost/admin/x", { headers: { cookie } }),
      (session) => new Response(session.adminLevel),
      () => new Response("no-session"),
    );
    expect(await authed.text()).toBe("owner");

    const anonymous = await withSession(
      new Request("http://localhost/admin/x"),
      () => new Response("session"),
      () => new Response("no-session"),
    );
    expect(await anonymous.text()).toBe("no-session");
  });
});
