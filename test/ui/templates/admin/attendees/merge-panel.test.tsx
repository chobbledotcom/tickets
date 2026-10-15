import { assert } from "@std/assert";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeMergeDiff } from "#shared/merge/attendee-merge-types.ts";
import { AttendeeMergePanel } from "#templates/admin/attendees/merge-panel.tsx";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";
import { says } from "#test-utils/says.ts";

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

    says(
      html,
      '<form action="/admin/attendees/42/actions" class="inline-row" method="get">',
    );
    says(
      html,
      '<input autofocus id="token" name="token" placeholder="Enter ticket token…" required type="text" value="">',
    );
    says(html, "<span>Search</span>");
    assert(!html.includes("Merge Preview"));
    assert(!html.includes('action="/admin/attendees/42/merge"'));
  });

  test("preserves a searched token and renders an escaped error", () => {
    const html = String(
      AttendeeMergePanel(target, null, "bad&token", "No <match> found."),
    );

    says(
      html,
      '<div autofocus class="error" role="alert" tabindex="-1">No &lt;match&gt; found.</div>',
    );
    says(html, 'value="bad&amp;token"');
  });

  test("waits for a complete diff before showing the preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, undefined),
    );

    says(html, 'id="token" name="token"');
    assert(!html.includes('<input autofocus id="token"'));
    assert(!html.includes("Merge Preview"));
    assert(!html.includes('action="/admin/attendees/42/merge"'));
  });

  test("renders the complete destructive merge preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, diff),
    );

    says(html, "<h3>Merge Preview</h3>");
    says(
      html,
      '<form action="/admin/attendees/42/merge" autocomplete="off" method="POST">',
    );
    says(
      html,
      '<input name="source_token" type="hidden" value="source&amp;token">',
    );
    says(
      html,
      '<input name="merge_version" type="hidden" value="merge-version-9">',
    );
    says(html, "Keep current: Target &lt;Person&gt;");
    says(html, "Use source: Source &amp; Person");
    says(
      html,
      "<strong>Warning:</strong> This will permanently delete the source attendee. This cannot be undone.",
    );
    says(html, '<button class="danger" type="submit"><svg aria-hidden="true"');
    says(html, "<span>Merge and delete source attendee</span></button>");
  });
});
