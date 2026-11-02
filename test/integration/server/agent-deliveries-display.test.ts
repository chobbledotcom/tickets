/**
 * What the run sheet displays: the owner's Liquid templates, the template
 * link, and servicing events on the round.
 *
 * Split from `agent-deliveries.test.ts`, which owns the driver's actions.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { setLogisticsAssignments } from "#db/logistics.ts";
import { settings } from "#db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import { testDate } from "#test-utils/dates.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignOwnerAgents,
  fetchDeliveriesHtml,
  makeTodayBooking,
  makeVan,
} from "#test-utils/deliveries.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { createServicingHold } from "#test-utils/servicing.ts";
import { createTestAgentSession } from "#test-utils/session.ts";
import { enableFeature, withSetting } from "#test-utils/settings.ts";

const TEMPLATE_SETTINGS_PATH =
  "/admin/settings-advanced#settings-logistics-run-sheet";

describeWithEnv("server (run sheet display)", { db: true }, () => {
  test("a servicing event with a logistics agent shows on the run sheet", async () => {
    // Servicing rows carry delivery legs, but the attendee lookup used to keep
    // only regular attendees, so a servicing job never reached the sheet.
    await enableFeature("logistics");
    const van = await makeVan("Van 9");
    await assignOwnerAgents([van]);
    const { id, listing } = await createServicingHold({
      date: testDate(todayInTz(settings.timezone)),
      durationDays: 1,
      name: "Boiler Service",
    });
    await setLogisticsAssignments(
      id,
      false,
      new Map([
        [
          listing.id,
          {
            endAgentId: van,
            endTime: "17:00",
            startAgentId: van,
            startTime: "09:00",
          },
        ],
      ]),
    );

    const html = await fetchDeliveriesHtml();
    assertStringIncludes(html, "Boiler Service");
    assertStringIncludes(html, listing.name);
    assertStringIncludes(html, "Drop-off");
    // A servicing event has no contact details, so those lines stay out.
    assert(!html.includes("delivery-phone"));
  });

  test("the owner's body template renders the day's bookings", async () => {
    await enableFeature("logistics");
    const van = await makeVan("Van 8");
    await assignOwnerAgents([van]);
    await makeTodayBooking(van, van);

    const html = await withSetting(
      {
        logistics_run_sheet_body:
          "<p>Own template: {% for booking in day.bookings %}{{ booking.name }}{% endfor %}</p>",
      },
      fetchDeliveriesHtml,
    );

    assertStringIncludes(html, "Own template: Alice");
    assert(!html.includes("<strong>Name:</strong>"));
  });

  test("the owner's heading template renders each day's heading", async () => {
    await enableFeature("logistics");
    const van = await makeVan("Van 7");
    await assignOwnerAgents([van]);
    await makeTodayBooking(van, van);

    const html = await withSetting(
      { logistics_run_sheet_heading: "{{ relative }} day" },
      fetchDeliveriesHtml,
    );

    assertStringIncludes(html, "<h2>today day</h2>");
    assertStringIncludes(html, "<h2>tomorrow day</h2>");
  });

  test("staff get the template link, and it goes when logistics is off", async () => {
    await enableFeature("logistics");
    assertStringIncludes(await fetchDeliveriesHtml(), TEMPLATE_SETTINGS_PATH);

    await setAdminFeatureEnabled("logistics", false);
    assert(
      !(await fetchDeliveriesHtml()).includes("settings-logistics-run-sheet"),
    );
    await enableFeature("logistics");
  });

  test("an agent sees no template link", async () => {
    const van = await makeVan("Van 6");
    const { cookie } = await createTestAgentSession({
      agentIds: [van],
      token: "a16",
      username: "agent16",
    });
    await makeTodayBooking(van, van);

    const response = await awaitTestRequest("/admin/deliveries", { cookie });
    assert(!(await response.text()).includes("settings-logistics-run-sheet"));
  });
});
