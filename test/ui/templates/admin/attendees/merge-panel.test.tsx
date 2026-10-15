import { assert, assertStringIncludes } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeMergeDiff } from "#shared/merge/attendee-merge-types.ts";
import { AttendeeMergePanel } from "#templates/admin/attendees/merge-panel.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";

describe("AttendeeMergePanel", () => {
  beforeAll(setupAdminPageTest);

  const target = testAttendee({ id: 42, name: "Target <Person>" });
  const source = {
    address: "1 Source Street",
    bookings: [],
    email: "source@example.com",
    id: 77,
    name: "Source & Person",
    phone: "0123456789",
    special_instructions: "Source notes",
    ticket_token: "source&token",
  };
  const diff: AttendeeMergeDiff = {
    answerItems: [],
    bookingItems: [],
    piiFields: [],
    sourceId: 77,
    targetId: 42,
    version: "merge-version-9",
  };

  test("renders an empty token search without a merge form", () => {
    const html = String(AttendeeMergePanel(target, null, null));

    assertStringIncludes(
      html,
      '<form action="/admin/attendees/42/actions" class="inline-row" method="get">',
    );
    assertStringIncludes(
      html,
      '<input autofocus id="token" name="token" placeholder="Enter ticket token…" required type="text" value="">',
    );
    assertStringIncludes(html, "<span>Search</span>");
    assert(
      !html.includes("Merge Preview"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('action="/admin/attendees/42/merge"'),
      "the value should not contain the searched item",
    );
  });

  test("preserves a searched token and renders an escaped error", () => {
    const html = String(
      AttendeeMergePanel(target, null, "bad&token", "No <match> found."),
    );

    assertStringIncludes(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">No &lt;match&gt; found.</div>',
    );
    assertStringIncludes(html, 'value="bad&amp;token"');
  });

  test("waits for a complete diff before showing the preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, undefined),
    );

    assertStringIncludes(html, 'id="token" name="token"');
    assert(
      !html.includes('<input autofocus id="token"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("Merge Preview"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('action="/admin/attendees/42/merge"'),
      "the value should not contain the searched item",
    );
  });

  test("renders the complete destructive merge preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, diff),
    );

    assertStringIncludes(html, "<h3>Merge Preview</h3>");
    assertStringIncludes(
      html,
      '<form action="/admin/attendees/42/merge" autocomplete="off" method="POST">',
    );
    assertStringIncludes(
      html,
      '<input name="source_token" type="hidden" value="source&amp;token">',
    );
    assertStringIncludes(
      html,
      '<input name="merge_version" type="hidden" value="merge-version-9">',
    );
    assertStringIncludes(html, "Keep current: Target &lt;Person&gt;");
    assertStringIncludes(html, "Use source: Source &amp; Person");
    assertStringIncludes(
      html,
      "<strong>Warning:</strong> This will permanently delete the source attendee. This cannot be undone.",
    );
    assertStringIncludes(
      html,
      '<button class="danger" type="submit"><svg aria-hidden="true"',
    );
    assertStringIncludes(
      html,
      "<span>Merge and delete source attendee</span></button>",
    );
  });
});
