import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { signCsrfToken } from "#shared/csrf.ts";
import { formatDateLabel } from "#shared/date-labels.ts";
import { addDays } from "#shared/dates.ts";
import { todayInTz } from "#shared/timezone.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { says, saysNot } from "#test-utils/says.ts";
import { createTestAgentSession, testCookie } from "#test-utils/session.ts";
import { enableFeature } from "#test-utils/settings.ts";
import {
  agentHireDeliveriesHtml,
  assignOwnerAgents,
  fetchDeliveriesForDate,
  fetchDeliveriesHtml,
  makeBookingOn,
  makeTodayBooking,
  makeVan,
  markRequest,
} from "./agent-deliveries-helpers.ts";

describeWithEnv("server (agent deliveries)", { db: true }, () => {
  test("agent sees their run sheet for today", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a1",
      username: "agent1",
    });
    // Two drop-off legs share a time, so the run-sheet sort's listing-name
    // tie-break (listing names are unique) resolves by name.
    await makeTodayBooking(van, van);
    await makeTodayBooking(van, van, 1, "Bouncy Castle 2");

    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    expect(response.status).toBe(200);
    const html = await response.text();
    says(html, "Bouncy Castle");
    says(html, "Alice");
    says(html, "Drop-off");
    says(html, "Collection");
    says(html, "09:00");
  });

  test("a one-day hire is collected the same day it is dropped off", async () => {
    const html = await agentHireDeliveriesHtml(1, "a13", "agent13");
    // Both legs fall in the Today section, before the Tomorrow heading.
    const tomorrowIdx = html.indexOf("Tomorrow");
    expect(html.indexOf("Drop-off")).toBeLessThan(tomorrowIdx);
    expect(html.indexOf("Collection")).toBeLessThan(tomorrowIdx);
    // Nothing is scheduled for tomorrow.
    says(html, "Nothing scheduled");
  });

  test("a two-day hire is collected the day after it is dropped off", async () => {
    const html = await agentHireDeliveriesHtml(2, "a14", "agent14");
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
    says(await response.text(), "no logistics agents assigned");
  });

  test("agent with agents but no bookings sees empty state", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a3",
      username: "agent3",
    });
    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    says(await response.text(), "No deliveries scheduled");
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
      date: todayInTz(settings.timezone),
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(markResponse, "/admin/deliveries");

    const after = await awaitTestRequest("/admin/deliveries", { cookie });
    says(await after.text(), "Mark not done");

    // Toggling it back off takes the "not done" message branch.
    const unmark = await markRequest(cookie, {
      attendee_id: String(attendeeId),
      date: todayInTz(settings.timezone),
      done: "0",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(unmark, "/admin/deliveries");
    const reverted = await awaitTestRequest("/admin/deliveries", { cookie });
    says(await reverted.text(), "Mark done");
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
      date: todayInTz(settings.timezone),
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    const location = expectRedirect(response, "/admin/deliveries");
    says(location, "flash");
  });

  test("marking with a date outside today or tomorrow is rejected", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a15",
      username: "agent15",
    });
    const { attendeeId, listingId } = await makeTodayBooking(van, van);

    const response = await markRequest(cookie, {
      attendee_id: String(attendeeId),
      date: addDays(testDate(todayInTz(settings.timezone)), 2),
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(response, "/admin/deliveries");

    const after = await awaitTestRequest("/admin/deliveries", { cookie });
    says(await after.text(), "Mark done");
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
      date: todayInTz(settings.timezone),
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
    await enableFeature("logistics");
    const html = await fetchDeliveriesHtml();
    // Staff (unlike agents) get the full navigation and the Calendar submenu
    // link to the deliveries page.
    says(html, 'id="main-nav"');
    says(html, 'href="/admin/deliveries"');
  });

  test("staff with no assigned agents see the no-agents prompt", async () => {
    const html = await fetchDeliveriesHtml();
    says(html, "no logistics agents assigned");
  });

  test("staff can open a future date and see that day's deliveries", async () => {
    const van = await makeVan("Van 1");
    await assignOwnerAgents([van]);
    const today = testDate(todayInTz(settings.timezone));
    const future = addDays(today, 10);
    await makeBookingOn(van, van, future, 1, "Future Castle");

    const html = await fetchDeliveriesForDate(future);
    // The picked day's booking is shown, headed by its full date label (it is
    // neither today nor tomorrow).
    says(html, "Future Castle");
    says(html, formatDateLabel(future));
  });

  test("staff can mark a leg done on a future date they opened", async () => {
    // Agents are pinned to today/tomorrow, but staff may open any date — so a
    // mark on a far-future run-sheet day must be accepted, not rejected as an
    // out-of-window date.
    const van = await makeVan("Van 1");
    await assignOwnerAgents([van]);
    const future = addDays(testDate(todayInTz(settings.timezone)), 10);
    const { attendeeId, listingId } = await makeBookingOn(
      van,
      van,
      future,
      1,
      "Future Castle",
    );

    const response = await markRequest(await testCookie(), {
      attendee_id: String(attendeeId),
      date: future,
      done: "1",
      kind: "start",
      listing_id: String(listingId),
    });
    expectRedirect(response, "/admin/deliveries");

    const html = await fetchDeliveriesForDate(future);
    says(html, "Mark not done");
  });

  test("staff run sheet offers a date picker linking to their delivery dates", async () => {
    const van = await makeVan("Van 1");
    await assignOwnerAgents([van]);
    const future = addDays(testDate(todayInTz(settings.timezone)), 10);
    await makeBookingOn(van, van, future, 1, "Future Castle");

    const html = await fetchDeliveriesHtml();
    // The shared calendar picker renders, with the future delivery date as a
    // selectable link back into the run sheet.
    says(html, "date-picker");
    says(html, `/admin/deliveries?date=${future}`);
  });

  test("an agent cannot steer the date — the ?date= param is ignored", async () => {
    const van = await makeVan("Van 1");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a15",
      username: "agent15",
    });
    const today = testDate(todayInTz(settings.timezone));
    const future = addDays(today, 10);
    await makeBookingOn(van, van, today, 1, "Today Castle");
    await makeBookingOn(van, van, future, 1, "Future Castle");

    const response = await awaitTestRequest(
      `/admin/deliveries?date=${future}`,
      { cookie },
    );
    const html = await response.text();
    // The agent stays pinned to today and tomorrow: today's booking shows, the
    // future one the param asked for does not, and no date picker is offered.
    says(html, "Today Castle");
    saysNot(html, "Future Castle");
    saysNot(html, "date-picker");
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
