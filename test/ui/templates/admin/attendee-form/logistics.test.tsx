import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeLogisticsData } from "#routes/admin/attendee-logistics.ts";
import { LogisticsSection } from "#templates/admin/attendee-form/logistics.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";

const logistics: AttendeeLogisticsData = {
  agents: [
    { id: 7, name: "Morning van" },
    { id: 8, name: "Evening van" },
  ],
  lines: [
    {
      assignment: {
        endAgentId: 8,
        endTime: "18:30",
        startAgentId: null,
        startTime: "10:15",
      },
      listingId: 42,
      name: "Boat trip",
    },
  ],
  single: {
    endAgentId: null,
    endTime: "17:00",
    startAgentId: 7,
    startTime: "09:00",
  },
  split: true,
};

describe("LogisticsSection", () => {
  beforeAll(setupAdminPageTest);

  test("renders nothing when logistics does not apply", () => {
    expect(LogisticsSection({ logistics: undefined })).toBeNull();
  });

  test("renders shared and per-listing assignments", () => {
    const html = String(LogisticsSection({ logistics }));

    expectIncludesAll(html, [
      'checked class="split-agents-toggle" name="split_logistics_agents"',
      'name="logistics_start_time" type="time" value="09:00"',
      'name="logistics_end_time" type="time" value="17:00"',
      "Morning van",
      "Evening van",
      "Boat trip",
      'name="logistics_start_time_42" type="time" value="10:15"',
      'name="logistics_end_time_42" type="time" value="18:30"',
      'name="logistics_start_42"',
      'name="logistics_end_42"',
    ]);
  });
});
