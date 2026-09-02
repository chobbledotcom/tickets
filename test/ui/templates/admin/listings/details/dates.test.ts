import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("listing details table date rows", () => {
  registerListingTemplateHooks();

  /** Frozen so each countdown keeps leftover hours: the rendered "N days and M
   *  hours" text depends on the clock's time of day, and the leftover drops
   *  to zero hours for one hour each day. */
  const COUNTDOWN_NOW = new Date("2026-06-01T00:00:00Z");

  /** The countdown a date row shows after its label. */
  const countdown = (): RegExp =>
    / <small><em>\(\d+ days? and \d+ hours? from now\)<\/em><\/small>/;

  test("the listing date links to the calendar and carries its countdown", () => {
    using _time = new FakeTime(COUNTDOWN_NOW);
    const html = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({
        closes_at: "2030-03-04T05:06:00Z",
        date: "2030-01-02T03:04:00Z",
      }),
    });
    expect(html).toMatch(
      new RegExp(
        `<a href="/admin/calendar\\?date=2030-01-02">[^<]+</a>${
          countdown().source
        }`,
      ),
    );
  });

  test("a registration deadline shows its countdown; no deadline says so", () => {
    using _time = new FakeTime(COUNTDOWN_NOW);
    const deadline = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({
        closes_at: "2030-03-04T05:06:00Z",
        date: "",
      }),
    });
    expect(deadline).toContain("Registration Closes");
    expect(deadline).toMatch(
      new RegExp(`Monday 4 March 2030 at 05:06 GMT${countdown().source}`),
    );
    // The deadline carries no calendar link.
    expect(deadline).not.toContain("/admin/calendar?date=");

    const none = renderListingDetail({
      allowedDomain: "localhost",
      attendees: [],
      listing: testListingWithCount({ closes_at: null, date: "" }),
    });
    expect(none).toContain("No deadline");
    expect(none).not.toContain("from now)");
  });
});
