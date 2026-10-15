import { assert } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import { testBuiltSite } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

test("renders the empty list with its renewal summary", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [],
      sort: "name",
    }),
  );
  says(html, "No built sites recorded.");
  says(html, "Renewal tiers");
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
      sort: "name",
    }),
  );
  says(html, 'href="/admin/built-sites/42">Child site</a>');
  says(html, "https://child.example");
  says(html, "Assigned (attendee #17)");
  says(html, "beta");
  says(html, "host-42");
});

test("labels an unassigned site that others can book as Available", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [testBuiltSite({ assignable: true, id: 1, name: "Alpha" })],
      sort: "name",
    }),
  );
  says(html, '<a href="/admin/built-sites/1">Alpha</a>');
  says(html, "Available</td>");
  assert(!html.includes("Not assignable"));
});

test("labels an unassigned site nobody can book as Not assignable", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [testBuiltSite({ assignable: false, id: 2, name: "Beta" })],
      sort: "name",
    }),
  );
  says(html, '<a href="/admin/built-sites/2">Beta</a>');
  says(html, "Not assignable</td>");
  assert(!html.includes("Available</td>"));
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
      sort: "name",
    }),
  );
  says(html, 'href="https://childsite.b-cdn.net"');
  assert(!html.includes("bunny.run"));
});

test("renders the list actions and guide destination", () => {
  const actions = String(BuiltSitesListActions());
  says(actions, 'href="/admin/built-sites/new"');
  says(actions, 'href="/admin/builder"');
  says(String(BuiltSitesGuideFooter()), 'href="/admin/guide#built-sites"');
});
