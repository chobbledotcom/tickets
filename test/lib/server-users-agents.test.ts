import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getSessionCookieName } from "#shared/cookies.ts";
import {
  getAllLogisticsAgents,
  logisticsAgentsTable,
} from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserAgentIds } from "#shared/db/user-agents.ts";
import { deleteUser, getUserByUsername } from "#shared/db/users.ts";
import {
  adminFormPost,
  adminGet,
  createTestAgentSession,
  describeWithEnv,
  expectHtml,
  expectRedirect,
  mockRequest,
} from "#test-utils";

const inviteAgent = (username: string, agentId?: string) =>
  adminFormPost("/admin/users", {
    admin_level: "agent",
    username,
    ...(agentId ? { agent_ids: agentId } : {}),
  });

const enableLogisticsWithVan = async () => {
  await settings.update.hasLogistics(true);
  return await logisticsAgentsTable.insert({ name: "Van 1" });
};

const vanWithAssignedAgent = async (token: string, username: string) => {
  const van = await enableLogisticsWithVan();
  const { userId } = await createTestAgentSession({
    agentIds: [van.id],
    token,
    username,
  });
  return { userId, van };
};

describeWithEnv("server (agent user management)", { db: true }, () => {
  test("inviting an agent persists their assigned logistics agents", async () => {
    const van = await enableLogisticsWithVan();

    const { response } = await inviteAgent("driverbob", String(van.id));
    expect(response.status).toBe(302);

    const user = await getUserByUsername("driverbob");
    expect(await getUserAgentIds(user!.id)).toEqual([van.id]);
  });

  test("inviting an agent drops unknown agent ids", async () => {
    await enableLogisticsWithVan();

    const { response } = await inviteAgent("driverjoe", "99999");
    expect(response.status).toBe(302);

    const user = await getUserByUsername("driverjoe");
    expect(await getUserAgentIds(user!.id)).toEqual([]);
  });

  test("the manage page lists an agent user's assigned logistics agents", async () => {
    const { userId } = await vanWithAssignedAgent("umanage", "drivermanage");

    await expectHtml(await adminGet(`/admin/users/${userId}`), {
      contains: ["drivermanage", "Van 1", `/admin/users/${userId}/agents`],
      status: 200,
    });
  });

  test("the edit-agents page renders the agent's checkboxes", async () => {
    const { userId } = await vanWithAssignedAgent("ua1", "driveredit");

    await expectHtml(await adminGet(`/admin/users/${userId}/agents`), {
      contains: ["Assigned agents for driveredit", 'name="agent_ids"'],
      status: 200,
    });
  });

  test("the edit-agents form saves the chosen agents", async () => {
    const van = await enableLogisticsWithVan();
    const { userId } = await createTestAgentSession({
      token: "ua2",
      username: "driversave",
    });

    const { response } = await adminFormPost(`/admin/users/${userId}/agents`, {
      agent_ids: String(van.id),
    });
    expectRedirect(response, "/admin/users");
    expect(await getUserAgentIds(userId)).toEqual([van.id]);
  });

  test("editing agents for a non-agent user is rejected", async () => {
    // User 1 is the owner created during setup — not a delivery agent.
    const response = await adminGet("/admin/users/1/agents");
    expect(response.status).toBe(400);
  });

  test("editing agents for a missing user is a 404", async () => {
    const response = await adminGet("/admin/users/99999/agents");
    expect(response.status).toBe(404);
  });

  test("posting agents for a missing user is a 404", async () => {
    const { response } = await adminFormPost("/admin/users/99999/agents", {
      agent_ids: "1",
    });
    expect(response.status).toBe(404);
  });

  test("the users list shows an agent's assigned agent names", async () => {
    await vanWithAssignedAgent("ua4", "listedagent");

    const response = await adminGet("/admin/users");
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("listedagent");
    expect(html).toContain("Van 1");
  });

  test("posting agents for a non-agent user is rejected", async () => {
    const { response } = await adminFormPost("/admin/users/1/agents", {
      agent_ids: "1",
    });
    expect(response.status).toBe(400);
  });

  test("deleting an agent user removes their links but keeps the agents", async () => {
    const { van, userId } = await vanWithAssignedAgent("ua6", "driverdel");
    expect(await getUserAgentIds(userId)).toEqual([van.id]);

    await deleteUser(userId);

    expect(await getUserAgentIds(userId)).toEqual([]);
    const agents = await getAllLogisticsAgents();
    expect(agents.some((a) => a.id === van.id)).toBe(true);
  });

  test("agents cannot reach the user management page", async () => {
    const { cookie } = await createTestAgentSession({
      token: "ua3",
      username: "drivernoadmin",
    });
    const response = await handleRequest(
      mockRequest("/admin/users", { headers: { cookie } }),
    );
    expect(response.status).toBe(403);
    // Sanity: the cookie really is a valid session cookie.
    expect(cookie.startsWith(`${getSessionCookieName()}=`)).toBe(true);
  });
});
