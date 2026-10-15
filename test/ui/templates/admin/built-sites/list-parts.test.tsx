import { assert, assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import {
  BuiltSitesGuideFooter,
  BuiltSitesListActions,
  BuiltSitesListBody,
} from "#templates/admin/built-sites/list-parts.tsx";
import { testBuiltSite } from "#test-utils/factories.ts";

test("renders the empty list with its renewal summary", () => {
  const html = String(
    BuiltSitesListBody({
      hostingIds: "",
      renewalTiers: [],
      sites: [],
      sort: "name",
    }),
  );
  assertStringIncludes(html, "No built sites recorded.");
  assertStringIncludes(html, "Renewal tiers");
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
  assertStringIncludes(html, 'href="/admin/built-sites/42">Child site</a>');
  assertStringIncludes(html, "https://child.example");
  assertStringIncludes(html, "Assigned (attendee #17)");
  assertStringIncludes(html, "beta");
  assertStringIncludes(html, "host-42");
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
  assertStringIncludes(html, '<a href="/admin/built-sites/1">Alpha</a>');
  assertStringIncludes(html, "Available</td>");
  assert(
    !html.includes("Not assignable"),
    "the value should not contain the searched item",
  );
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
  assertStringIncludes(html, '<a href="/admin/built-sites/2">Beta</a>');
  assertStringIncludes(html, "Not assignable</td>");
  assert(
    !html.includes("Available</td>"),
    "the value should not contain the searched item",
  );
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
  assertStringIncludes(html, 'href="https://childsite.b-cdn.net"');
  assert(
    !html.includes("bunny.run"),
    "the value should not contain the searched item",
  );
});

test("renders the list actions and guide destination", () => {
  const actions = String(BuiltSitesListActions());
  assertStringIncludes(actions, 'href="/admin/built-sites/new"');
  assertStringIncludes(actions, 'href="/admin/builder"');
  assertStringIncludes(
    String(BuiltSitesGuideFooter()),
    'href="/admin/guide#built-sites"',
  );
});
