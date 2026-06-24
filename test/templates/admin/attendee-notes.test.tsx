import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import type { SystemNote } from "#shared/db/system-notes.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  AttendeeNotesSection,
  AttendeeNotesSummary,
  adminAddNotePage,
  adminDeleteNotePage,
} from "#templates/admin/attendee-notes.tsx";
import { setupTestEncryptionKey } from "#test-utils";

const SESSION: AdminSession = { adminLevel: "owner" };

const note = (overrides: Partial<SystemNote> = {}): SystemNote => ({
  attendee_id: 5,
  created: "2026-06-23T10:00:00.000Z",
  id: 1,
  note: "Refunded — see the [ledger](/admin/ledger?attendee=5).",
  type: "system",
  ...overrides,
});

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("AttendeeNotesSection", () => {
  test("renders a system note as a red alert with its markdown link", () => {
    const html = String(
      <AttendeeNotesSection attendeeId={5} notes={[note()]} />,
    );
    expect(html).toContain("system-note-alert");
    expect(html).toContain('role="alert"');
    // The markdown body is rendered (the ledger link survives).
    expect(html).toContain('href="/admin/ledger?attendee=5"');
    // The × opens the are-you-sure delete page, returning to the attendee page.
    expect(html).toContain(
      "/admin/attendee/5/note/1/delete?return_url=%2Fadmin%2Fattendees%2F5",
    );
  });

  test("renders an owner note without the alert styling", () => {
    const html = String(
      <AttendeeNotesSection
        attendeeId={5}
        notes={[note({ note: "private reminder", type: "owner" })]}
      />,
    );
    expect(html).toContain("private reminder");
    expect(html).not.toContain("system-note-alert");
  });

  test("always offers an add-note link, even with no notes", () => {
    const html = String(<AttendeeNotesSection attendeeId={7} notes={[]} />);
    expect(html).toContain(
      "/admin/attendee/7/note?return_url=%2Fadmin%2Fattendees%2F7",
    );
    expect(html).not.toContain("system-note-alert");
  });
});

describe("AttendeeNotesSummary", () => {
  test("renders an expandable grouped by attendee with the count", () => {
    const names = new Map([
      [5, "Alice"],
      [6, "Bob"],
    ]);
    const html = String(
      <AttendeeNotesSummary
        names={names}
        notes={[
          note({ attendee_id: 5, id: 1, note: "first" }),
          note({ attendee_id: 5, id: 2, note: "second" }),
          note({ attendee_id: 6, id: 3, note: "other" }),
        ]}
      />,
    );
    expect(html).toContain("<details");
    expect(html).toContain("2 attendees have notes");
    expect(html).toContain('href="/admin/attendees/5"');
    expect(html).toContain("Alice");
    expect(html).toContain("first");
    expect(html).toContain("other");
  });

  test("falls back to the id when a name is unknown", () => {
    const html = String(
      <AttendeeNotesSummary
        names={new Map()}
        notes={[note({ attendee_id: 9 })]}
      />,
    );
    expect(html).toContain("#9");
  });

  test("renders nothing when there are no notes", () => {
    const html = String(<AttendeeNotesSummary names={new Map()} notes={[]} />);
    expect(html).not.toContain("<details");
    expect(html).not.toContain("have notes");
  });
});

describe("adminAddNotePage", () => {
  test("renders the add form scoped to the attendee", () => {
    const html = adminAddNotePage({
      attendeeId: 5,
      attendeeName: "Alice Example",
      returnUrl: "/admin/attendees/5",
      session: SESSION,
    });
    expect(html).toContain("Add a note for Alice Example");
    expect(html).toContain('action="/admin/attendee/5/note"');
    expect(html).toContain('name="note"');
    expect(html).toContain('name="csrf_token"');
    expect(html).toContain(
      'name="return_url" type="hidden" value="/admin/attendees/5"',
    );
  });

  test("shows a flash error when re-rendered after a rejected save", () => {
    const html = adminAddNotePage({
      attendeeId: 5,
      attendeeName: "Alice",
      error: "Enter a note before saving.",
      returnUrl: "",
      session: SESSION,
    });
    expect(html).toContain("Enter a note before saving.");
  });
});

describe("adminDeleteNotePage", () => {
  test("asks for confirmation without a copy/paste field", () => {
    const html = adminDeleteNotePage({
      note: note({ note: "delete this" }),
      returnUrl: "/admin/attendees/5",
      session: SESSION,
    });
    expect(html).toContain("Are you sure");
    expect(html).toContain("delete this");
    expect(html).toContain('action="/admin/attendee/5/note/1/delete"');
    // The intermediate page is deliberately NOT the copy/paste confirmation.
    expect(html).not.toContain('name="confirm_identifier"');
    // It bounces back via return_url.
    expect(html).toContain('value="/admin/attendees/5"');
  });
});
