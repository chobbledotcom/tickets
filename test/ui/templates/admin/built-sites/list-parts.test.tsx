import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import { testBuiltSite, testListingWithCount } from "#test-utils/factories.ts";

/** One site's row, rendered alone and cut off before the renewal tier summary
 * — the summary lists the same tiers in the same markup, so an assertion over
 * the whole body could not tell a row's cell from a summary row. */
const rowFor = (
  site: Parameters<typeof testBuiltSite>[0],
  renewalTiers: Parameters<typeof BuiltSitesListBody>[0]["renewalTiers"] = [],
): string =>
  String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers,
      sites: [testBuiltSite(site)],
    }),
  ).split("<section>")[0]!;

test("renders the empty list with its renewal summary", () => {
  const html = String(
    BuiltSitesListBody({ hostingIds: "", renewalTiers: [], sites: [] }),
  );
  expect(html).toContain("No built sites recorded.");
  expect(html).toContain("Renewal tiers");
});

test("renders a site's link, URL, status, channel, and host id", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "host-42",
      renewalTiers: [],
      sites: [
        testBuiltSite({
          assignable: false,
          assignedAttendeeId: 17,
          id: 42,
          name: "Child site",
          readOnlyFrom: "",
          siteUrl: "https://child.example",
          updates: "beta",
        }),
      ],
    }),
  );
  expect(html).toContain('href="/admin/built-sites/42">Child site</a>');
  expect(html).toContain("https://child.example");
  expect(html).toContain("Assigned (attendee #17)");
  expect(html).toContain("beta");
  expect(html).toContain("host-42");
});

test("calls an unassigned assignable site available, and only that one", () => {
  const html = rowFor({ assignable: true, id: 1, name: "Spare" });
  expect(html).toContain("<td>Available</td>");
  expect(html).not.toContain("Not assignable");
});

test("calls an unassigned unassignable site not assignable, and only that one", () => {
  const html = rowFor({ assignable: false, id: 2, name: "Held back" });
  expect(html).toContain("<td>Not assignable</td>");
  expect(html).not.toContain("<td>Available</td>");
});

const monthlyTier = testListingWithCount({ id: 11, name: "Monthly tier" });

test("names the tier a site renews on, linking its listing", () => {
  const html = rowFor({ id: 1, renewalTierListingId: 11 }, [monthlyTier]);
  expect(html).toContain(
    '<td><a href="/admin/listing/11">Monthly tier</a></td>',
  );
  expect(html).not.toContain("<td>Any</td>");
  expect(html).not.toContain("<td>Tier removed</td>");
});

test("says any tier when the site is on no particular one", () => {
  const html = rowFor({ id: 1, renewalTierListingId: null }, [monthlyTier]);
  expect(html).toContain("<td>Any</td>");
  expect(html).not.toContain("<td>Tier removed</td>");
  // The tier's own link still appears in the summary below the table, so the
  // row's cell is what this checks.
  expect(html).not.toContain(
    '<td><a href="/admin/listing/11">Monthly tier</a></td>',
  );
});

test("says the tier was removed when the chosen one no longer qualifies", () => {
  const html = rowFor({ id: 1, renewalTierListingId: 99 }, [monthlyTier]);
  expect(html).toContain("<td>Tier removed</td>");
  expect(html).not.toContain("<td>Any</td>");
  expect(html).not.toContain(
    '<td><a href="/admin/listing/11">Monthly tier</a></td>',
  );
});

test("renders the list actions and guide destination", () => {
  const actions = String(BuiltSitesListActions());
  expect(actions).toContain('href="/admin/built-sites/new"');
  expect(actions).toContain('href="/admin/builder"');
  expect(String(BuiltSitesGuideFooter())).toContain(
    'href="/admin/guide#built-sites"',
  );
});
