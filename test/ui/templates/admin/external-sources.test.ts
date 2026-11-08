import { assert, assertStringIncludes } from "@std/assert";
import { it as test } from "@std/testing/bdd";
import type {
  ExternalSource,
  ExternalSourceLink,
} from "#db/external-sources/types.ts";
import {
  adminExternalSourcesPage,
  type ExternalSourceEntry,
} from "#templates/admin/external-sources.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { featureSetting, useSetting } from "#test-utils/settings.ts";

const mockSession = {
  adminLevel: "owner" as const,
  token: "test-token",
  userId: 1,
  wrappedDataKey: null,
};

const source: ExternalSource = {
  created: "2026-11-03T09:00:00.000Z",
  id: 1,
  name: "Village diary",
  url_pattern: "https://diary.example/events/{external_id}",
};

const link = (
  fields: Partial<ExternalSourceLink> = {},
): ExternalSourceLink => ({
  created: "2026-11-03T09:05:00.000Z",
  external_id: "EVT-1",
  external_id_index: null,
  id: 1,
  link_id: 7,
  link_type: "listing",
  source_id: source.id,
  ...fields,
});

const pageOf = (entries: readonly ExternalSourceEntry[]): string =>
  adminExternalSourcesPage(mockSession, entries);

describeWithEnv("external sources page", { encryptionKey: true }, () => {
  useSetting(featureSetting("externalSources"));
  test("names the directory and marks its own menu entry", () => {
    const html = pageOf([{ links: [link()], source }]);
    assertStringIncludes(html, "External sources");
    assertStringIncludes(html, 'class="active" href="/admin/external-sources"');
  });

  test("shows each source's stored name, pattern, and added date", () => {
    const html = pageOf([{ links: [], source }]);
    assertStringIncludes(html, "<h2>Village diary</h2>");
    assertStringIncludes(
      html,
      "<code>https://diary.example/events/{external_id}</code>",
    );
    assertStringIncludes(html, source.created);
  });

  test("names the record a link belongs to and opens its own page", () => {
    const html = pageOf([{ links: [link()], source }]);
    assertStringIncludes(html, '<a href="/admin/listing/7">Listing 7</a>');
    assertStringIncludes(
      html,
      '<a href="https://diary.example/events/EVT-1">https://diary.example/events/EVT-1</a>',
    );
    assertStringIncludes(html, "EVT-1");
  });

  test("says a record has no external id yet", () => {
    const html = pageOf([{ links: [link({ external_id: null })], source }]);
    assertStringIncludes(html, "Not named yet");
    // The pattern itself still shows; only the filled address is absent.
    assert(!html.includes('href="https://diary.example/events/'));
  });

  test("opens attendee and group records on their own pages", () => {
    const html = pageOf([
      {
        links: [
          link({ id: 2, link_id: 3, link_type: "attendee" }),
          link({ id: 3, link_id: 4, link_type: "group" }),
        ],
        source,
      },
    ]);
    assertStringIncludes(html, '<a href="/admin/attendees/3">Attendee 3</a>');
    assertStringIncludes(html, '<a href="/admin/groups/4">Group 4</a>');
  });

  test("says when the directory holds no sources", () => {
    assertStringIncludes(pageOf([]), "No sources yet.");
  });

  test("says when one source holds no links", () => {
    assertStringIncludes(pageOf([{ links: [], source }]), "No links yet.");
  });

  test("links to the guide section that explains the directory", () => {
    expectIncludesAll(pageOf([{ links: [link()], source }]), [
      '<a class="guide-link" href="/admin/guide#external-sources">',
      "<span>External sources guide</span>",
    ]);
  });
});
