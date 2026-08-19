import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { SystemNote } from "#db/notes/types.ts";
import {
  AddNoteLink,
  AttendeeNotesSection,
  AttendeeNotesSummary,
  adminNoteDeletePage,
  adminNoteNewPage,
} from "#templates/admin/attendee-notes.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { withEnv } from "#test-utils/env.ts";

const note = (overrides: Partial<SystemNote> = {}): SystemNote => ({
  created: "2026-06-23T10:00:00.000Z",
  entity_id: 5,
  entity_type: "attendee",
  id: 1,
  note: "Refunded — see the [ledger](/admin/ledger?attendee=5).",
  type: "system",
  ...overrides,
});

describe("AttendeeNotesSection", () => {
  beforeAll(setupAdminPageTest);

  test("renders a system note as a red alert with its markdown link", () => {
    const html = String(<AttendeeNotesSection isOwner notes={[note()]} />);
    expect(html).toContain("system-note-alert");
    expect(html).toContain('role="alert"');
    // The markdown body is rendered — for an OWNER the ledger link survives.
    expect(html).toContain('href="/admin/ledger?attendee=5"');
    // The × opens the are-you-sure delete page, returning to the attendee page.
    expect(html).toContain(
      "/admin/attendee/5/note/1/delete?return_url=%2Fadmin%2Fattendees%2F5",
    );
  });

  test("demotes the ledger link to plain text for a non-owner admin", () => {
    const html = String(
      <AttendeeNotesSection isOwner={false} notes={[note()]} />,
    );
    // The words stay, the owner-only link goes — a rendered link is a promise
    // that it works, and only owners may open the ledger pages.
    expect(html).toContain("see the ledger");
    expect(html).not.toContain('href="/admin/ledger?attendee=5"');
  });

  test("demotes the attendee ledger-tab link too, not just standalone /admin/ledger", () => {
    // The attendee page's ledger tab (/admin/attendees/:id/ledger) is also
    // owner-only — PaymentDetails links to it, and an operator could paste it
    // into a note. Without catching it, a non-owner would see a dead link.
    const ledgerTabNote = note({
      note: "Check the [ledger](/admin/attendees/5/ledger).",
    });
    const staffHtml = String(
      <AttendeeNotesSection isOwner={false} notes={[ledgerTabNote]} />,
    );
    expect(staffHtml).toContain("Check the ledger");
    expect(staffHtml).not.toContain('href="/admin/attendees/5/ledger"');

    const ownerHtml = String(
      <AttendeeNotesSection isOwner notes={[ledgerTabNote]} />,
    );
    expect(ownerHtml).toContain('href="/admin/attendees/5/ledger"');
  });

  test("renders an owner note without the alert styling", () => {
    const html = String(
      <AttendeeNotesSection
        isOwner={false}
        notes={[note({ note: "private reminder", type: "owner" })]}
      />,
    );
    expect(html).toContain("private reminder");
    expect(html).not.toContain("system-note-alert");
  });

  test("renders nothing when there are no notes", () => {
    // The empty section is dropped entirely (null renders as "" inside its
    // parent fragment) — the "Add a note" affordance now lives beside the page
    // heading (see AddNoteLink), not here.
    expect(AttendeeNotesSection({ isOwner: false, notes: [] })).toBeNull();
  });

  test("hides the delete link in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = String(<AttendeeNotesSection isOwner notes={[note()]} />);
    expect(html).toContain("Refunded");
    expect(html).not.toContain("/admin/attendee/5/note/1/delete");
  });
});

describe("AddNoteLink", () => {
  beforeAll(setupAdminPageTest);

  test("links to the add-note page, returning to the attendee page", () => {
    const html = String(<AddNoteLink attendeeId={7} />);
    expect(html).toContain(
      "/admin/attendee/7/note?return_url=%2Fadmin%2Fattendees%2F7",
    );
  });
});

describe("AttendeeNotesSummary", () => {
  beforeAll(setupAdminPageTest);

  test("renders an expandable grouped by attendee with the count", () => {
    const names = new Map([
      [5, "Alice"],
      [6, "Bob"],
    ]);
    const html = String(
      <AttendeeNotesSummary
        isOwner={false}
        names={names}
        notes={[
          note({ entity_id: 5, id: 1, note: "first" }),
          note({ entity_id: 5, id: 2, note: "second" }),
          note({ entity_id: 6, id: 3, note: "other" }),
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
        isOwner={false}
        names={new Map()}
        notes={[note({ entity_id: 9 })]}
      />,
    );
    expect(html).toContain("#9");
  });

  test("demotes a note's ledger link for non-owners but keeps it for owners", () => {
    // A rendered link is a promise that it works: the ledger pages are
    // owner-only, so a non-owner sees the words without the link.
    const staffHtml = String(
      <AttendeeNotesSummary
        isOwner={false}
        names={new Map([[5, "Alice"]])}
        notes={[note({ entity_id: 5 })]}
      />,
    );
    expect(staffHtml).toContain("see the ledger");
    expect(staffHtml).not.toContain('href="/admin/ledger?attendee=5"');

    const ownerHtml = String(
      <AttendeeNotesSummary
        isOwner
        names={new Map([[5, "Alice"]])}
        notes={[note({ entity_id: 5 })]}
      />,
    );
    expect(ownerHtml).toContain('href="/admin/ledger?attendee=5"');
  });

  test("renders nothing when there are no notes", () => {
    const html = String(
      <AttendeeNotesSummary isOwner={false} names={new Map()} notes={[]} />,
    );
    expect(html).not.toContain("<details");
    expect(html).not.toContain("have notes");
  });
});

describe("adminNoteNewPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the add form scoped to the attendee", () => {
    const html = adminNoteNewPage({
      attendeeId: 5,
      attendeeName: "Alice Example",
      returnUrl: "/admin/attendees/5",
      session: OWNER_SESSION,
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
    const html = adminNoteNewPage({
      attendeeId: 5,
      attendeeName: "Alice",
      error: "Enter a note before saving.",
      returnUrl: "",
      session: OWNER_SESSION,
    });
    expect(html).toContain("Enter a note before saving.");
  });
});

describe("adminNoteDeletePage", () => {
  beforeAll(setupAdminPageTest);

  test("asks for confirmation without a copy/paste field", () => {
    const html = adminNoteDeletePage({
      note: note({ note: "delete this" }),
      returnUrl: "/admin/attendees/5",
      session: OWNER_SESSION,
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
