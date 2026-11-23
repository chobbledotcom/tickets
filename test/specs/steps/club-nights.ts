import { Then, When } from "@cucumber/cucumber";
import { assertStringIncludes } from "@std/assert";
import { t } from "#i18n";
import {
  adminPageHtmlAt,
  keepsWhatTheOrganiserSaw,
  ORGANISER,
} from "#test/specs/support/browser.ts";
import { groupNamed } from "#test/specs/support/groups.ts";
import {
  type TicketsWorld,
  whatTheyWereTold,
} from "#test/specs/support/world.ts";
import { regionOutOf } from "#test-utils/test-browser/parsing.ts";

/** The organiser opens one form of the dashboard and keeps what it said. */
const opensDashboard = (path: string) =>
  async function (this: TicketsWorld): Promise<void> {
    keepsWhatTheOrganiserSaw(this, await adminPageHtmlAt(this, path));
  };

When("the organiser opens the club night dashboard", opensDashboard("/admin/"));

When(
  "the organiser opens the full dashboard",
  opensDashboard("/admin/?view=full"),
);

/** One night's block: from its heading to the end of its links. */
const nightOn = (html: string, groupName: string): string =>
  regionOutOf(html, `>${groupName}</a></h2>`, "</p></div>", groupName);

Then(
  "the dashboard shows {string} with {string}",
  function (this: TicketsWorld, groupName: string, listingName: string): void {
    assertStringIncludes(
      nightOn(whatTheyWereTold(this, ORGANISER), groupName),
      `>${listingName}</a>`,
    );
  },
);

Then(
  "the dashboard offers the scanner for {string}",
  async function (this: TicketsWorld, groupName: string): Promise<void> {
    const { id } = await groupNamed(groupName);
    assertStringIncludes(
      nightOn(whatTheyWereTold(this, ORGANISER), groupName),
      `href="/admin/groups/${id}/scanner"`,
    );
  },
);

Then(
  "the dashboard shows {string} under other listings",
  function (this: TicketsWorld, listingName: string): void {
    const heading = `<h2>${t("admin.dashboard.other_listings")}</h2>`;
    assertStringIncludes(
      regionOutOf(
        whatTheyWereTold(this, ORGANISER),
        heading,
        "</table>",
        heading,
      ),
      `>${listingName}</a>`,
    );
  },
);

Then(
  "the dashboard offers the club night dashboard",
  function (this: TicketsWorld): void {
    assertStringIncludes(
      whatTheyWereTold(this, ORGANISER),
      `<a href="/admin/">${t("admin.dashboard.show_club_night")}</a>`,
    );
  },
);
