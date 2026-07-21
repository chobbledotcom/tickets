import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import { testBuiltSite } from "#test-utils/factories.ts";

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

test("distinguishes available and unavailable unassigned sites", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [
        testBuiltSite({ assignable: true, id: 1, name: "Available" }),
        testBuiltSite({ assignable: false, id: 2, name: "Unavailable" }),
      ],
    }),
  );
  expect(html).toContain("Available</a>");
  expect(html).toContain("Available</td>");
  expect(html).toContain("Unavailable</a>");
  expect(html).toContain("Not assignable");
});

test("renders the list actions and guide destination", () => {
  const actions = String(BuiltSitesListActions());
  expect(actions).toContain('href="/admin/built-sites/new"');
  expect(actions).toContain('href="/admin/builder"');
  expect(String(BuiltSitesGuideFooter())).toContain(
    'href="/admin/guide#built-sites"',
  );
});
