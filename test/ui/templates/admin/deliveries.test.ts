import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AdminSession } from "#shared/types.ts";
import {
  agentDeliveriesPage,
  type DeliveriesDateNav,
  type DeliveryBookingView,
  type DeliveryDayGroup,
  type DeliveryLegView,
} from "#templates/admin/deliveries.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";

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

  test("shows a prompt when no agents are assigned", () => {
    const html = agentDeliveriesPage(
      [],
      "44",
      { noAgents: true },
      agentSession,
      null,
    );
    expect(html).toContain("no logistics agents assigned");
    expect(html).toContain("/admin/logout");
  });

  test("shows an empty message when every day is empty", () => {
    const html = renderDeliveries([
      { bookings: [], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    expect(html).toContain("No deliveries scheduled");
  });

  test("renders a drop-off booking with labelled details, maps, phone and a done toggle", () => {
    const html = renderDeliveries([
      { bookings: [booking()], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    expect(html).toContain("Drop-off");
    expect(html).toContain("09:00");
    expect(html).toContain("Van 1");
    // Details are prefixed with bold labels.
    expect(html).toContain("<strong>Name:</strong> Alice");
    expect(html).toContain("<strong>Listing:</strong> Bouncy Castle");
    expect(html).toContain("<strong>Address:</strong> 1 Test Street");
    expect(html).toContain("<strong>Phone:</strong>");
    expect(html).toContain("tel:+447700900000");
    expect(html).toContain("https://wa.me/447700900000");
    expect(html).toContain('action="/admin/deliveries/mark"');
    expect(html).toContain('value="start"');
    expect(html).toContain('name="date" type="hidden" value="2026-06-16"');
    expect(html).toContain("Mark done");
    // The ticket token the customer can quote is shown.
    expect(html).toContain("<strong>Token:</strong> TOKEN123");
    // The empty Tomorrow group shows its own placeholder.
    expect(html).toContain("Nothing scheduled");
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
    expect(html).toContain("Drop-off");
    expect(html).toContain("Collection");
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
    expect(html).toContain("Collection");
    expect(html).toContain("Mark not done");
    expect(html).toContain("delivery-leg done");
    // Non-callable phone is shown as plain text, with no tel: link.
    expect(html).toContain("no-digits-here");
    expect(html).not.toContain("tel:");
    // No address line when the address is blank.
    expect(html).not.toContain("1 Test Street");
  });

  test("omits the phone line entirely when there is no phone", () => {
    const html = renderDeliveries([
      { bookings: [booking({ phone: "" })], heading: "Today" },
      { bookings: [], heading: "Tomorrow" },
    ]);
    expect(html).not.toContain("delivery-phone");
  });

  test("renders an error flash message", () => {
    const html = agentDeliveriesPage(
      [],
      "44",
      { error: "Something went wrong", noAgents: true },
      agentSession,
      null,
    );
    expect(html).toContain("Something went wrong");
  });

  test("renders a success flash message", () => {
    const html = agentDeliveriesPage(
      [],
      "44",
      { noAgents: true, success: "Marked done" },
      agentSession,
      null,
    );
    expect(html).toContain("Marked done");
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
    expect(html).not.toContain("date-picker");
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
    expect(html).toContain("date-picker");
    expect(html).toContain('href="/admin/deliveries?date=2026-07-06"');
    // Month paging keeps the deliveries route (not the calendar page).
    expect(html).toContain("/admin/deliveries?cal=");
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
    expect(html).toContain("/admin/deliveries?date=2026-07-12&amp;cal=");
  });
});
