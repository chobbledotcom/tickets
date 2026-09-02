import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  registerListingTemplateHooks,
  renderListingDetail,
} from "#test/ui/templates/admin/listings/helpers.ts";
import { testListingWithCount } from "#test-utils/factories.ts";

describe("listing details table date rows", () => {
  registerListingTemplateHooks();

  /** The countdown a date row shows after its label. The hours show only when
   *  they are not zero, so a deadline a whole number of days away reads as
   *  days alone. */
  const countdown = (): RegExp =>
    / <small><em>\(\d+ days?(?: and \d+ hours?)? from now\)<\/em><\/small>/;

  test("the listing date links to the calendar and carries its countdown", () => {
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
