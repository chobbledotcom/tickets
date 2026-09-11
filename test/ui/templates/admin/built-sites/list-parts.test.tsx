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

test("labels an unassigned site that others can book as Available", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [testBuiltSite({ assignable: true, id: 1, name: "Alpha" })],
    }),
  );
  expect(html).toContain('<a href="/admin/built-sites/1">Alpha</a>');
  expect(html).toContain("Available</td>");
  expect(html).not.toContain("Not assignable");
});

test("labels an unassigned site nobody can book as Not assignable", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [testBuiltSite({ assignable: false, id: 2, name: "Beta" })],
    }),
  );
  expect(html).toContain('<a href="/admin/built-sites/2">Beta</a>');
  expect(html).toContain("Not assignable</td>");
  expect(html).not.toContain("Available</td>");
});

test("links a bare bunny.run address as a working b-cdn.net link", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [
        testBuiltSite({
          id: 7,
          name: "Bunny-run site",
          siteUrl: "childsite.bunny.run",
        }),
      ],
    }),
  );
  expect(html).toContain('href="https://childsite.b-cdn.net"');
  expect(html).not.toContain("bunny.run");
});

test("renders the list actions and guide destination", () => {
  const actions = String(BuiltSitesListActions());
  expect(actions).toContain('href="/admin/built-sites/new"');
  expect(actions).toContain('href="/admin/builder"');
  expect(String(BuiltSitesGuideFooter())).toContain(
    'href="/admin/guide#built-sites"',
  );
});
