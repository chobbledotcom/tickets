import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import {
  adminFormPost,
  describeWithEnv,
  expectFlash,
  testRequiresAuth,
} from "#test-utils";

describeWithEnv("server (admin settings: calendar feeds)", { db: true }, () => {
  describe("POST /admin/settings/calendar-feeds", () => {
    test("loads calendar feed grouping from raw settings", async () => {
      await settings.setRaw("calendar_feeds_group_by", "listings");
      settings.invalidateCache();
      await settings.loadKeys(["calendar_feeds_group_by"]);
      expect(settings.calendarFeedsGroupBy).toBe("listings");

      await settings.setRaw("calendar_feeds_group_by", "unknown");
      settings.invalidateCache();
      await settings.loadKeys(["calendar_feeds_group_by"]);
      expect(settings.calendarFeedsGroupBy).toBe("attendees");
    });

    testRequiresAuth("/admin/settings/calendar-feeds", {
      body: {
        calendar_feeds_enabled: "true",
        calendar_feeds_group_by: "attendees",
      },
      method: "POST",
    });

    test("enables attendee-grouped calendar feeds", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/calendar-feeds",
        {
          calendar_feeds_enabled: "true",
          calendar_feeds_group_by: "attendees",
        },
      );

      expect(response.status).toBe(302);
      expect(settings.calendarFeedsEnabled).toBe(true);
      expect(settings.calendarFeedsGroupBy).toBe("attendees");
      expectFlash(response, expect.stringContaining("Calendar feeds enabled"));
    });

    test("enables listing-grouped calendar feeds", async () => {
      await adminFormPost("/admin/settings/calendar-feeds", {
        calendar_feeds_enabled: "true",
        calendar_feeds_group_by: "listings",
      });

      expect(settings.calendarFeedsEnabled).toBe(true);
      expect(settings.calendarFeedsGroupBy).toBe("listings");
    });

    test("disables calendar feeds", async () => {
      const { response } = await adminFormPost(
        "/admin/settings/calendar-feeds",
        {
          calendar_feeds_enabled: "false",
          calendar_feeds_group_by: "attendees",
        },
      );

      expect(response.status).toBe(302);
      expect(settings.calendarFeedsEnabled).toBe(false);
      expectFlash(response, expect.stringContaining("Calendar feeds disabled"));
    });
  });
});
