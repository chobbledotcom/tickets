import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { App } from "#test/blackbox/driver.ts";
import {
  boxTicked,
  followed,
  loggedIn,
  redirectOf,
  type SettingsForm,
  send,
  testFormGuards,
} from "#test/blackbox/settings.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const CALENDAR_FEEDS: SettingsForm = {
  action: "/admin/settings/calendar-feeds",
  field: "calendarFeedsEnabled",
  page: "/admin/settings",
};

/** What the form shows as saved: the box, and the chosen grouping. */
interface Shown {
  enabled: boolean;
  groupBy: string;
}

const shownNow = async (app: App): Promise<Shown> => {
  const { html } = await app.get(CALENDAR_FEEDS.page);
  const select = html.match(
    /<select\b[^>]*name="calendarFeedsGroupBy"[^>]*>[\s\S]*?<\/select>/,
  );
  const chosen = select?.[0].match(/<option selected value="([^"]*)"/)?.[1];
  if (chosen === undefined) throw new Error("The page shows no grouping.");
  return {
    enabled: boxTicked(html, "calendarFeedsEnabled"),
    groupBy: chosen,
  };
};

/** The owner saves the form and reads the message on the next page. */
const save = async (
  app: App,
  enabled: boolean,
  groupBy: string,
): Promise<string> => {
  const sent = await send(app, CALENDAR_FEEDS, {
    calendarFeedsEnabled: enabled ? "true" : null,
    calendarFeedsGroupBy: groupBy,
  });
  const to = new URL(redirectOf(sent), "http://localhost");
  expect(to.searchParams.get("form")).toBe("settings-calendar-feeds");
  return (await followed(app, sent)).html;
};

const START: Shown = { enabled: false, groupBy: "attendees" };

describeWithEnv(
  "the setting /admin/settings/calendar-feeds",
  { db: true },
  () => {
    test("a new site shows the feeds off, grouped by attendees", async () => {
      expect(await shownNow(await loggedIn())).toEqual(START);
    });

    for (const groupBy of ["attendees", "listings"]) {
      test(`a ticked box turns the feeds on, grouped by ${groupBy}`, async () => {
        const app = await loggedIn();
        expect(await save(app, true, groupBy)).toContain(
          `Calendar feeds enabled (${groupBy})`,
        );
        expect(await shownNow(app)).toEqual({ enabled: true, groupBy });
      });
    }

    test("an unticked box turns the feeds off again", async () => {
      const app = await loggedIn();
      await save(app, true, "listings");
      expect(await save(app, false, "attendees")).toContain(
        "Calendar feeds disabled",
      );
      expect(await shownNow(app)).toEqual(START);
    });

    test("a grouping that the form does not offer saves as attendees", async () => {
      const app = await loggedIn();
      await save(app, true, "listings");
      await save(app, true, "nonsense");
      expect(await shownNow(app)).toEqual({
        enabled: true,
        groupBy: "attendees",
      });
    });

    testFormGuards(CALENDAR_FEEDS, "true", shownNow, START);
  },
);
