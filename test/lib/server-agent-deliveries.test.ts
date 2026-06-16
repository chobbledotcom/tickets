import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb } from "#shared/db/client.ts";
import { setLogisticsAssignments } from "#shared/db/logistics.ts";
import { logisticsAgentsTable } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  awaitTestRequest,
  createTestAgentSession,
  createTestAttendee,
  createTestListing,
  describeWithEnv,
  expectRedirect,
  mockFormRequest,
  mockRequest,
  testCookie,
} from "#test-utils";

/** Create a logistics agent and return its id. */
const makeVan = async (name: string): Promise<number> =>
  (await logisticsAgentsTable.insert({ name })).id;

/** Create a booking for today with the given drop-off/collection agents. */
const makeTodayBooking = async (
  startAgent: number,
  endAgent: number,
): Promise<{ attendeeId: number; listingId: number; listingName: string }> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    name: "Bouncy Castle",
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Alice",
    "alice@example.com",
    1,
    "07700900000",
  );
  await setLogisticsAssignments(
    attendee.id,
    false,
    new Map([
      [
        listing.id,
        {
          endAgentId: endAgent,
          endTime: "17:00",
          startAgentId: startAgent,
          startTime: "09:00",
        },
      ],
    ]),
  );
  const today = todayInTz(settings.timezone);
  await getDb().execute({
    args: [`${today}T00:00:00Z`, `${today}T00:00:00Z`, attendee.id, listing.id],
    sql: "UPDATE listing_attendees SET start_at = ?, end_at = ? WHERE attendee_id = ? AND listing_id = ?",
  });
  return {
    attendeeId: attendee.id,
    listingId: listing.id,
    listingName: "Bouncy Castle",
  };
};

const markRequest = async (
  cookie: string,
  data: Record<string, string>,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      "/admin/deliveries/mark",
      { csrf_token: await signCsrfToken(), ...data },
      cookie,
    ),
  );

describeWithEnv("server (agent deliveries)", { db: true }, () => {
  test("agent sees their run sheet for today", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a1",
      username: "agent1",
    });
    // Two bookings whose drop-off legs share the same time exercise the
    // run-sheet sort's listing-name tie-break.
    await makeTodayBooking(van, van);
    await makeTodayBooking(van, van);

    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Bouncy Castle");
    expect(html).toContain("Alice");
    expect(html).toContain("Drop-off");
    expect(html).toContain("Collection");
    expect(html).toContain("09:00");
  });

  test("agent with no assigned agents sees a prompt", async () => {
    const { cookie } = await createTestAgentSession({
      token: "a2",
      username: "agent2",
    });
    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("no logistics agents assigned");
  });

  test("agent with agents but no bookings sees empty state", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a3",
      username: "agent3",
    });
    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(await response.text()).toContain("No deliveries scheduled");
  });

  test("agent can mark a leg done and see it reflected", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a4",
      username: "agent4",
    });
    const { attendeeId, listingId } = await makeTodayBooking(van, van);

    const markResponse = await markRequest(cookie, {
      attendee_id: String(attendeeId),
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(markResponse, "/admin/deliveries");

    const after = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(await after.text()).toContain("Mark not done");

    // Toggling it back off takes the "not done" message branch.
    const unmark = await markRequest(cookie, {
      attendee_id: String(attendeeId),
      done: "0",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(unmark, "/admin/deliveries");
    const reverted = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(await reverted.text()).toContain("Mark done");
  });

  test("marking a leg the agent does not own is rejected", async () => {
    const van = await makeVan("Van 1");
    const otherVan = await makeVan("Van 2");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a5",
      username: "agent5",
    });
    const { attendeeId, listingId } = await makeTodayBooking(
      otherVan,
      otherVan,
    );

    const response = await markRequest(cookie, {
      attendee_id: String(attendeeId),
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    const location = expectRedirect(response, "/admin/deliveries");
    expect(location).toContain("flash");
  });

  test("marking with missing ids is rejected", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a6",
      username: "agent6",
    });
    const response = await markRequest(cookie, {
      done: "1",
      kind: "start",
      listing_id: "1",
    });
    expectRedirect(response, "/admin/deliveries");
  });

  test("marking with an invalid kind is rejected", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a7",
      username: "agent7",
    });
    const response = await markRequest(cookie, {
      attendee_id: "1",
      done: "1",
      kind: "middle",
      listing_id: "1",
    });
    expectRedirect(response, "/admin/deliveries");
  });

  test("agents are blocked from staff pages", async () => {
    const { cookie } = await createTestAgentSession({
      token: "a8",
      username: "agent8",
    });
    for (const path of ["/admin/settings", "/admin/users", "/admin/calendar"]) {
      const response = await handleRequest(
        mockRequest(path, { headers: { cookie } }),
      );
      expect(response.status).toBe(403);
    }
  });

  test("visiting /admin redirects agents to their run sheet", async () => {
    const { cookie } = await createTestAgentSession({
      token: "a9",
      username: "agent9",
    });
    const response = await handleRequest(
      mockRequest("/admin/", { headers: { cookie } }),
    );
    expectRedirect(response, "/admin/deliveries");
  });

  test("login page redirects logged-in agents to their run sheet", async () => {
    const { cookie } = await createTestAgentSession({
      token: "a10",
      username: "agent10",
    });
    const response = await handleRequest(
      mockRequest("/admin/login", { headers: { cookie } }),
    );
    expectRedirect(response, "/admin/deliveries");
  });

  test("agents can log out", async () => {
    const { cookie } = await createTestAgentSession({
      token: "a11",
      username: "agent11",
    });
    const response = await handleRequest(
      mockFormRequest(
        "/admin/logout",
        { csrf_token: await signCsrfToken() },
        cookie,
      ),
    );
    expect(response.status).toBe(302);
  });

  test("staff cannot view the agent run sheet", async () => {
    const response = await handleRequest(
      mockRequest("/admin/deliveries", {
        headers: { cookie: await testCookie() },
      }),
    );
    expect(response.status).toBe(403);
  });

  test("logging in as an agent lands on the run sheet", async () => {
    const van = await makeVan("Van 1");
    await createTestAgentSession({
      agentIds: [van],
      password: "agentpass123",
      token: "a12",
      username: "loginagent",
    });
    const response = await handleRequest(
      mockFormRequest("/admin/login", {
        csrf_token: await signCsrfToken(),
        password: "agentpass123",
        username: "loginagent",
      }),
    );
    expectRedirect(response, "/admin/deliveries");
  });
});
