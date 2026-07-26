import { expect } from "@std/expect";
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

    expect(html).toContain(
      '<form action="/admin/attendees/42/actions" class="inline-row" method="get">',
    );
    expect(html).toContain(
      '<input autofocus id="token" name="token" placeholder="Enter ticket token…" required type="text" value="">',
    );
    expect(html).toContain("<span>Search</span>");
    expect(html).not.toContain("Merge Preview");
    expect(html).not.toContain('action="/admin/attendees/42/merge"');
  });

  test("preserves a searched token and renders an escaped error", () => {
    const html = String(
      AttendeeMergePanel(target, null, "bad&token", "No <match> found."),
    );

    expect(html).toContain(
      '<div autofocus class="error" role="alert" tabindex="-1">No &lt;match&gt; found.</div>',
    );
    expect(html).toContain('value="bad&amp;token"');
  });

  test("waits for a complete diff before showing the preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, undefined),
    );

    expect(html).toContain('id="token" name="token"');
    expect(html).not.toContain('<input autofocus id="token"');
    expect(html).not.toContain("Merge Preview");
    expect(html).not.toContain('action="/admin/attendees/42/merge"');
  });

  test("renders the complete destructive merge preview", () => {
    const html = String(
      AttendeeMergePanel(target, source, "source&token", undefined, diff),
    );

    expect(html).toContain("<h3>Merge Preview</h3>");
    expect(html).toContain(
      '<form action="/admin/attendees/42/merge" autocomplete="off" method="POST">',
    );
    expect(html).toContain(
      '<input name="source_token" type="hidden" value="source&amp;token">',
    );
    expect(html).toContain(
      '<input name="merge_version" type="hidden" value="merge-version-9">',
    );
    expect(html).toContain("Keep current: Target &lt;Person&gt;");
    expect(html).toContain("Use source: Source &amp; Person");
    expect(html).toContain(
      "<strong>Warning:</strong> This will permanently delete the source attendee. This cannot be undone.",
    );
    expect(html).toContain(
      '<button class="danger" type="submit"><svg aria-hidden="true"',
    );
    expect(html).toContain(
      "<span>Merge and delete source attendee</span></button>",
    );
  });
});
