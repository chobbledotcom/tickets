import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { addDays } from "#shared/dates.ts";
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

/** Create a booking dropped off today with the given drop-off/collection
 * agents. `durationDays` is the hire length in whole days: `end_at` is the
 * exclusive end (start + duration), so a 1-day hire is collected the same day
 * and a 2-day hire the next day. */
const makeTodayBooking = async (
  startAgent: number,
  endAgent: number,
  durationDays = 1,
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
  const endDate = addDays(today, durationDays);
  await getDb().execute({
    args: [
      `${today}T00:00:00Z`,
      `${endDate}T00:00:00Z`,
      attendee.id,
      listing.id,
    ],
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

/** Fetch the staff run sheet as HTML, asserting the request succeeds. */
const fetchDeliveriesHtml = async (): Promise<string> => {
  const response = await handleRequest(
    mockRequest("/admin/deliveries", {
      headers: { cookie: await testCookie() },
    }),
  );
  expect(response.status).toBe(200);
  return response.text();
};

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

  test("a one-day hire is collected the same day it is dropped off", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a13",
      username: "agent13",
    });
    await makeTodayBooking(van, van, 1);

    const html = await (
      await awaitTestRequest("/admin/deliveries", { cookie })
    ).text();
    // Both legs fall in the Today section, before the Tomorrow heading.
    const tomorrowIdx = html.indexOf("Tomorrow");
    expect(html.indexOf("Drop-off")).toBeLessThan(tomorrowIdx);
    expect(html.indexOf("Collection")).toBeLessThan(tomorrowIdx);
    // Nothing is scheduled for tomorrow.
    expect(html).toContain("Nothing scheduled");
  });

  test("a two-day hire is collected the day after it is dropped off", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a14",
      username: "agent14",
    });
    await makeTodayBooking(van, van, 2);

    const html = await (
      await awaitTestRequest("/admin/deliveries", { cookie })
    ).text();
    // Drop-off is in the Today section; collection moves to the Tomorrow one.
    const tomorrowIdx = html.indexOf("Tomorrow");
    expect(html.indexOf("Drop-off")).toBeLessThan(tomorrowIdx);
    expect(html.indexOf("Collection")).toBeGreaterThan(tomorrowIdx);
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

  test("unauthenticated visitors are redirected away from the run sheet", async () => {
    const response = await handleRequest(mockRequest("/admin/deliveries"));
    expect(response.status).toBe(302);
  });

  test("staff can view the run sheet and see the staff nav and Calendar submenu", async () => {
    await settings.update.hasLogistics(true);
    const html = await fetchDeliveriesHtml();
    // Staff (unlike agents) get the full navigation and the Calendar submenu
    // link to the deliveries page.
    expect(html).toContain('id="main-nav"');
    expect(html).toContain('href="/admin/deliveries"');
  });

  test("staff with no assigned agents see the no-agents prompt", async () => {
    const html = await fetchDeliveriesHtml();
    expect(html).toContain("no logistics agents assigned");
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
