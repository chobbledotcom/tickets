import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  requireAgentOr,
  requireContentOr,
  requireDeliveryOr,
  requireOwnerOr,
  requireSessionOr,
  requireSiteOr,
} from "#routes/auth.ts";
import {
  createTestAgentSession,
  createTestEditorSession,
  createTestManagerSession,
  describeWithEnv,
  testCookie,
} from "#test-utils";

/** A session guard: authenticates, checks role, and either runs the handler or
 *  returns an auth-failure response. */
type Guard = (request: Request, handler: () => Response) => Promise<Response>;

/** A live, authenticated cookie for each admin level. */
const roleCookies = async (): Promise<Record<string, string>> => ({
  agent: (await createTestAgentSession()).cookie,
  editor: (await createTestEditorSession()).cookie,
  manager: await createTestManagerSession(),
  owner: await testCookie(),
});

/** Run a guard for a cookie and report the status: 200 when the handler ran
 *  (allowed), 403 when the role was rejected. Every cookie is a valid session,
 *  so a rejection is always "forbidden", never the not-authenticated redirect. */
const guardStatus = async (guard: Guard, cookie: string): Promise<number> => {
  const request = new Request("http://localhost/admin/x", {
    headers: { cookie },
  });
  const response = await guard(request, () => new Response("OK"));
  return response.status;
};

/** Assert a guard admits exactly `allowed` and forbids every other role. */
const expectAdmits = async (
  guard: Guard,
  cookies: Record<string, string>,
  allowed: string[],
): Promise<void> => {
  for (const [role, cookie] of Object.entries(cookies)) {
    expect(await guardStatus(guard, cookie)).toBe(
      allowed.includes(role) ? 200 : 403,
    );
  }
};

describeWithEnv("auth authorization matrix", { db: true }, () => {
  test("requireOwnerOr admits only the owner", async () => {
    await expectAdmits(requireOwnerOr, await roleCookies(), ["owner"]);
  });

  test("requireAgentOr admits only a delivery agent", async () => {
    await expectAdmits(requireAgentOr, await roleCookies(), ["agent"]);
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
});
