import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { RunSheetDay } from "#templates/admin/deliveries/run-sheet.tsx";
import {
  agentDeliveriesPage,
  type DeliveriesDateNav,
} from "#templates/admin/deliveries.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
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

/** One rendered day, as the route hands it to the page. */
const day = (over: Partial<RunSheetDay> = {}): RunSheetDay => ({
  bodyHtml: "<p>Bouncy Castle</p>",
  empty: false,
  heading: "Today",
  ...over,
});

describe("agentDeliveriesPage", () => {
  beforeAll(setupAdminPageTest);

  /** Render the page for the standard "agent has days" case. Agents get no
   *  date picker, so `dateNav` is null. */
  const renderDeliveries = (days: RunSheetDay[]): string =>
    agentDeliveriesPage(days, { noAgents: false }, agentSession, null);

  test("shows a prompt when no agents are assigned", async () => {
    await withRequestContext(() => {
      const html = agentDeliveriesPage(
        [],
        { noAgents: true },
        agentSession,
        null,
      );
      expectIncludesAll(html, [
        "no logistics agents assigned",
        "/admin/logout",
      ]);
    });
  });

  test("shows an empty message when every day is empty", () => {
    const html = renderDeliveries([
      day({ bodyHtml: "<p>Nothing scheduled.</p>", empty: true }),
      day({ bodyHtml: "<p>Nothing scheduled.</p>", empty: true }),
    ]);

    assertStringIncludes(html, "No deliveries scheduled");
  });

  test("renders each day's heading and its body markup", () => {
    const html = renderDeliveries([
      day({ bodyHtml: "<ul><li>Bouncy Castle</li></ul>", heading: "Today" }),
      day({
        bodyHtml: "<p>Nothing scheduled.</p>",
        empty: true,
        heading: "Tomorrow",
      }),
    ]);

    expectIncludesAll(html, [
      "<h2>Today</h2>",
      "<h2>Tomorrow</h2>",
      // The body is the template's own markup, not escaped text.
      "<ul><li>Bouncy Castle</li></ul>",
    ]);
  });

  test("renders an error flash message", () => {
    const html = agentDeliveriesPage(
      [],
      { error: "Something went wrong", noAgents: true },
      agentSession,
      null,
    );

    assertStringIncludes(html, "Something went wrong");
  });

  test("renders a success flash message", () => {
    const html = agentDeliveriesPage(
      [],
      { noAgents: true, success: "Marked done" },
      agentSession,
      null,
    );

    assertStringIncludes(html, "Marked done");
  });

  test("no date picker renders when none is supplied (the agent's case)", () => {
    // The route passes null for agents, so a driver stays pinned to today and
    // tomorrow with no picker.
    const html = renderDeliveries([day(), day({ empty: true })]);

    assert(!html.includes("date-picker"));
  });

  test("staff get the calendar date picker linking each date to the run sheet", () => {
    const html = agentDeliveriesPage(
      [day(), day({ empty: true })],
      { noAgents: false },
      managerSession,
      dateNav(),
    );

    // The shared calendar component renders, wired to reopen the run sheet.
    expectIncludesAll(html, [
      "date-picker",
      'href="/admin/deliveries?date=2026-07-06"',
      // Month paging keeps the deliveries route (not the calendar page).
      "/admin/deliveries?cal=",
    ]);
  });

  test("staff picker keeps the opened date while paging months", () => {
    const html = agentDeliveriesPage(
      [
        day({ heading: "Sunday 12 July 2026" }),
        day({ heading: "Monday 13 July 2026" }),
      ],
      { noAgents: false },
      managerSession,
      dateNav({ selected: "2026-07-12" }),
    );

    // Paging months carries the selected date so it stays highlighted (the
    // ampersand is HTML-escaped in the rendered href).
    assertStringIncludes(html, "/admin/deliveries?date=2026-07-12&amp;cal=");
  });

  test("links the owner to the template settings", () => {
    const html = agentDeliveriesPage(
      [day()],
      {
        editTemplateHref:
          "/admin/settings-advanced#settings-logistics-run-sheet",
        noAgents: false,
      },
      agentSession,
      null,
    );

    expectIncludesAll(html, [
      'href="/admin/settings-advanced#settings-logistics-run-sheet"',
      "Edit template",
    ]);
  });

  test("renders no template link when the viewer cannot edit it", () => {
    const html = renderDeliveries([day()]);

    assert(!html.includes("/admin/settings-advanced"));
    assert(!html.includes("Edit template"));
  });
});
