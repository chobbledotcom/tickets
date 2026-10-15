import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  agentDeliveriesPage,
  type DeliveriesDateNav,
  type DeliveryBookingView,
  type DeliveryDayGroup,
  type DeliveryLegView,
} from "#templates/admin/deliveries.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import type { AdminSession } from "#types";

/** Agent-class session so the page renders the agent header (no staff nav). */
const agentSession: AdminSession = { adminLevel: "agent" };

/** Staff session so the page renders the calendar date picker. */
const managerSession: AdminSession = { adminLevel: "manager" };

/** A date picker offering one selectable delivery date. */
const dateNav = (over: Partial<DeliveriesDateNav> = {}): DeliveriesDateNav => ({
  availableDates: [
    { label: "Monday 6 July 2026", selectable: true, value: "2026-07-06" },
  ],
  selected: null,
  today: "2026-07-06",
  viewMonth: null,
  ...over,
});

const leg = (over: Partial<DeliveryLegView> = {}): DeliveryLegView => ({
  agentName: "Van 1",
  date: "2026-06-16",
  done: false,
  kind: "start",
  time: "09:00",
  ...over,
});

const booking = (
  over: Partial<DeliveryBookingView> = {},
): DeliveryBookingView => ({
  address: "1 Test Street",
  attendeeId: 5,
  attendeeName: "Alice",
  legs: [leg()],
  listingId: 9,
  listingName: "Bouncy Castle",
  phone: "07700900000",
  ticketToken: "TOKEN123",
  ...over,
});

describe("agentDeliveriesPage", () => {
  beforeAll(setupAdminPageTest);

  /** Render the deliveries page for the standard "agent has groups" case.
   *  Agents get no date picker, so `dateNav` is null. Every test in this block
   *  that passes groups uses this exact call. */
  const renderDeliveries = (groups: DeliveryDayGroup[]): string =>
    agentDeliveriesPage(groups, "44", { noAgents: false }, agentSession, null);

  test("shows a prompt when no agents are assigned", async () => {
    await withRequestContext(() => {
      const html = agentDeliveriesPage(
        [],
        "44",
        { noAgents: true },
        agentSession,
        null,
      );
      assertStringIncludes(html, "no logistics agents assigned");
      assertStringIncludes(html, "/admin/logout");
    });
  });

  test("shows an empty message when every day is empty", () => {
    const html = renderDeliveries([
      { bookings: [], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    assertStringIncludes(html, "No deliveries scheduled");
  });

  test("renders a drop-off booking with labelled details, maps, phone and a done toggle", () => {
    const html = renderDeliveries([
      { bookings: [booking()], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    assertStringIncludes(html, "Drop-off");
    assertStringIncludes(html, "09:00");
    assertStringIncludes(html, "Van 1");
    // Details are prefixed with bold labels.
    assertStringIncludes(html, "<strong>Name:</strong> Alice");
    assertStringIncludes(html, "<strong>Listing:</strong> Bouncy Castle");
    assertStringIncludes(html, "<strong>Address:</strong> 1 Test Street");
    assertStringIncludes(html, "<strong>Phone:</strong>");
    assertStringIncludes(html, "tel:+447700900000");
    assertStringIncludes(html, "https://wa.me/447700900000");
    assertStringIncludes(html, 'action="/admin/deliveries/mark"');
    assertStringIncludes(html, 'value="start"');
    assertStringIncludes(html, 'name="date" type="hidden" value="2026-06-16"');
    assertStringIncludes(html, "Mark done");
    // The ticket token the customer can quote is shown.
    assertStringIncludes(html, "<strong>Token:</strong> TOKEN123");
    // The empty Tomorrow group shows its own placeholder.
    assertStringIncludes(html, "Nothing scheduled");
  });

  test("shows both the drop-off and collection jobs for a same-day booking", () => {
    const html = renderDeliveries([
      {
        bookings: [
          booking({
            legs: [
              leg({ kind: "end", time: "17:00" }),
              leg({ kind: "start", time: "09:00" }),
            ],
          }),
        ],
        heading: "Today",
      },
      { bookings: [], heading: "Tomorrow" },
    ]);
    assertStringIncludes(html, "Drop-off");
    assertStringIncludes(html, "Collection");
    // The shared booking details appear once, not once per leg.
    expect(html.match(/Bouncy Castle/g)).toHaveLength(1);
  });

  test("renders a collection job, a done job, and tolerates missing fields", () => {
    const html = renderDeliveries([
      {
        bookings: [
          booking({
            address: "",
            legs: [leg({ done: true, kind: "end", time: "" })],
            phone: "no-digits-here",
          }),
        ],
        heading: "Today",
      },
      { bookings: [], heading: "Tomorrow" },
    ]);
    assertStringIncludes(html, "Collection");
    assertStringIncludes(html, "Mark not done");
    assertStringIncludes(html, "delivery-leg done");
    // Non-callable phone is shown as plain text, with no tel: link.
    assertStringIncludes(html, "no-digits-here");
    assert(
      !html.includes("tel:"),
      "the value should not contain the searched item",
    );
    // No address line when the address is blank.
    assert(
      !html.includes("1 Test Street"),
      "the value should not contain the searched item",
    );
  });

  test("omits the phone line entirely when there is no phone", () => {
    const html = renderDeliveries([
      { bookings: [booking({ phone: "" })], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    assert(
      !html.includes("delivery-phone"),
      "the value should not contain the searched item",
    );
  });

  test("renders an error flash message", () => {
    const html = agentDeliveriesPage(
      [],
      "44",
      { error: "Something went wrong", noAgents: true },
      agentSession,
      null,
    );
    assertStringIncludes(html, "Something went wrong");
  });

  test("renders a success flash message", () => {
    const html = agentDeliveriesPage(
      [],
      "44",
      { noAgents: true, success: "Marked done" },
      agentSession,
      null,
    );
    assertStringIncludes(html, "Marked done");
  });

  test("no date picker renders when none is supplied (the agent's case)", () => {
    // The route passes null for agents, so a driver stays pinned to today and
    // tomorrow with no picker.
    const html = agentDeliveriesPage(
      [
        { bookings: [], heading: "Today" },
        { bookings: [], heading: "Tomorrow" },
      ],
      "44",
      { noAgents: false },
      agentSession,
      null,
    );
    assert(
      !html.includes("date-picker"),
      "the value should not contain the searched item",
    );
  });

  test("staff get the calendar date picker linking each date to the run sheet", () => {
    const html = agentDeliveriesPage(
      [
        { bookings: [], heading: "Today" },
        { bookings: [], heading: "Tomorrow" },
      ],
      "44",
      { noAgents: false },
      managerSession,
      dateNav(),
    );
    // The shared calendar component renders, wired to reopen the run sheet.
    assertStringIncludes(html, "date-picker");
    assertStringIncludes(html, 'href="/admin/deliveries?date=2026-07-06"');
    // Month paging keeps the deliveries route (not the calendar page).
    assertStringIncludes(html, "/admin/deliveries?cal=");
  });

  test("staff picker keeps the opened date while paging months", () => {
    const html = agentDeliveriesPage(
      [
        { bookings: [], heading: "Sunday 12 July 2026" },
        { bookings: [], heading: "Monday 13 July 2026" },
      ],
      "44",
      { noAgents: false },
      managerSession,
      dateNav({ selected: "2026-07-12" }),
    );
    // Paging months carries the selected date so it stays highlighted (the
    // ampersand is HTML-escaped in the rendered href).
    assertStringIncludes(html, "/admin/deliveries?date=2026-07-12&amp;cal=");
  });
});
