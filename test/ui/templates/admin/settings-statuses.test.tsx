import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import { t } from "#i18n";
import { FormParams } from "#shared/form-data.ts";
import {
  AttendeeStatusEditPanel,
  retireStatusDeletePage,
  type StatusRetire,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { withEnv } from "#test-utils/env.ts";

const RESERVED_STATUS: AttendeeStatus = {
  id: 7,
  isPaidDefault: true,
  isPublicDefault: true,
  isReservation: true,
  name: "Reserved",
  reservationAmount: "25%",
  sortOrder: 0,
};

const PLAIN_STATUS: AttendeeStatus = {
  id: 8,
  isPaidDefault: false,
  isPublicDefault: false,
  isReservation: false,
  name: "Checked in",
  reservationAmount: "0",
  sortOrder: 1,
};

describe("attendee status templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders writable status rows with flags and boundary-aware moves", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = statusPages.listPage(
      [RESERVED_STATUS, PLAIN_STATUS],
      OWNER_SESSION,
    );

    expectIncludesAll(html, [
      "<title>Attendee statuses</title>",
      'href="/admin/settings/statuses/new"',
      'href="/admin/settings/statuses/7"',
      '<span class="badge">Public default</span><span class="badge">Paid</span><span class="badge">Reservation: 25%</span>',
    ]);
    assert(!html.includes("Reservation: 0"));
    assertStringIncludes(
      html,
      'action="/admin/settings/statuses/7/move-after"',
    );
    assert(!html.includes('action="/admin/settings/statuses/7/move-before"'));
    assertStringIncludes(
      html,
      'action="/admin/settings/statuses/8/move-before"',
    );
    assert(!html.includes('action="/admin/settings/statuses/8/move-after"'));
    expectIncludesAll(html, ['title="Move down"', 'title="Move up"']);
  });

  test("keeps status data but removes write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = statusPages.listPage([RESERVED_STATUS], OWNER_SESSION);

    expectIncludesAll(html, ["Reserved", "Reservation: 25%"]);
    assert(!html.includes('href="/admin/settings/statuses/new"'));
    assert(!html.includes('href="/admin/settings/statuses/7"'));
    assert(!html.includes("/move-"));
  });

  test("renders blank create fields with the reservation default", () => {
    const html = statusPages.newPage(OWNER_SESSION);

    assertStringIncludes(html, 'action="/admin/settings/statuses"');
    expect(html).toMatch(/name="name"[^>]*value=""/);
    assertStringIncludes(html, 'name="isReservation" type="checkbox"');
    // The exclusive checkboxes carry data-exclusive attributes between
    // `checked` and `name`. A bare `checked name=` substring cannot prove
    // the flag is off, so match across the attributes.
    expect(html).not.toMatch(/<input checked[^>]*name="isReservation"/);
    expect(html).not.toMatch(/<input checked[^>]*name="isPublicDefault"/);
    expect(html).not.toMatch(/<input checked[^>]*name="isPaidDefault"/);
    expect(html).toMatch(/name="reservationAmount"[^>]*value="0"/);
    expectIncludesAll(html, [
      "<h1>Add attendee status</h1>",
      "<title>Add attendee status</title>",
      "Create status",
    ]);
  });

  test("prefills every stored edit field", () => {
    const html = String(AttendeeStatusEditPanel({ status: RESERVED_STATUS }));

    assertStringIncludes(html, 'action="/admin/settings/statuses/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Reserved"/);
    expect(html.match(/<input checked/g)).toHaveLength(3);
    expect(html).toMatch(/name="reservationAmount"[^>]*value="25%"/);
    assertStringIncludes(html, "Save status");
  });

  test("uses rejected values instead of restoring stored edit fields", () => {
    const values = new FormParams({
      isPublicDefault: "true",
      reservationAmount: "lots",
    });
    const html = String(
      AttendeeStatusEditPanel({
        error: "Invalid reservation amount",
        status: RESERVED_STATUS,
        values,
      }),
    );

    assertStringIncludes(html, "Invalid reservation amount");
    expect(html).toMatch(/name="name"[^>]*value=""/);
    assert(!html.includes('value="Reserved"'));
    expect(html).not.toMatch(/<input checked[^>]*name="isReservation"/);
    expect(html).toMatch(/<input checked[^>]*name="isPublicDefault"/);
    expect(html).not.toMatch(/<input checked[^>]*name="isPaidDefault"/);
    expect(html).toMatch(/name="reservationAmount"[^>]*value="lots"/);
  });

  test("gives every field the shape the browser needs", () => {
    const html = statusPages.newPage(OWNER_SESSION);

    expectIncludesAll(html, [
      '<input maxlength="250" name="name" required type="text"',
      '<input name="reservationAmount" type="text"',
      '<fieldset class="checkboxes">',
      '<label class="checkbox">',
    ]);
  });

  test("pairs the paid-default and reservation checkboxes so only one can hold", () => {
    // Checking either one disables the other and shows why; the server
    // refusal stays the authority for a stale or tampered submit.
    const html = statusPages.newPage(OWNER_SESSION);

    expect(html).toMatch(
      /data-exclusive-with="isReservation"[^>]*name="isPaidDefault"/,
    );
    expect(html).toMatch(
      /data-exclusive-with="isPaidDefault"[^>]*name="isReservation"/,
    );
    assertStringIncludes(html, t("statuses.error_paid_default_reservation"));
  });

  test("points its guide footer at the statuses part of the guide", () => {
    const html = statusPages.listPage([PLAIN_STATUS], OWNER_SESSION);

    assertStringIncludes(html, 'href="/admin/guide#attendee-statuses"');
  });

  test("keeps every rejected value, not only the ones the stored row had", () => {
    // The stored status has none of the three flags, so a checkbox that shows
    // as ticked can only have come from what the operator submitted.
    const values = new FormParams({
      isPaidDefault: "true",
      isReservation: "true",
      name: "Typed Instead",
    });

    const html = String(
      AttendeeStatusEditPanel({ status: PLAIN_STATUS, values }),
    );

    expect(html).toMatch(/name="name"[^>]*value="Typed Instead"/);
    expect(html).toMatch(/<input checked[^>]*name="isReservation"/);
    expect(html).toMatch(/<input checked[^>]*name="isPaidDefault"/);
    expect(html).not.toMatch(/<input checked[^>]*name="isPublicDefault"/);
  });

  test("renders a non-dangerous typed-name delete form", () => {
    const html = statusPages.deletePage(
      RESERVED_STATUS,
      OWNER_SESSION,
      "Status is still in use",
    );

    expectIncludesAll(html, [
      "Status is still in use",
      'action="/admin/settings/statuses/7/delete"',
      "<h1>Delete attendee status</h1>",
      "<title>Delete attendee status</title>",
      "Type the status name &quot;Reserved&quot; to confirm deletion:",
      'name="confirmIdentifier"',
      "Delete status",
    ]);
    assert(!html.includes('<button class="danger"'));
  });
});

describe("the delete page of a status attendees hold", () => {
  beforeAll(setupAdminPageTest);

  const BUSY_STATUS: AttendeeStatus = {
    id: 9,
    isPaidDefault: false,
    isPublicDefault: false,
    isReservation: false,
    name: "Busy",
    reservationAmount: "0",
    sortOrder: 2,
  };
  const OTHER_STATUS: AttendeeStatus = { ...PLAIN_STATUS, id: 8 };

  const render = (
    retire: StatusRetire | null,
    error?: string,
  ): ReturnType<typeof String> =>
    String(retireStatusDeletePage(BUSY_STATUS, retire, OWNER_SESSION, error));

  test("shows the count, a warning, and a required picker of the other statuses", () => {
    const html = render({ count: 1, others: [OTHER_STATUS] });

    expectIncludesAll(html, [
      "1 attendee holds this status.",
      t("statuses.delete_reassign_warning"),
    ]);
    expect(html).toMatch(/<select[^>]*name="reassignStatusId"[^>]*required/);
    // The empty prompt stays preselected, so a save without a real pick
    // cannot slip through the browser's own required check.
    expectIncludesAll(html, [
      '<option selected value="">',
      t("statuses.delete_reassign_prompt"),
      'value="8"',
      "Checked in",
    ]);
  });

  test("keeps the picker off a status nobody holds", () => {
    const html = render(null);

    assert(!html.includes('name="reassignStatusId"'));
    assert(!html.includes(t("statuses.delete_reassign_warning")));
  });

  test("renders a non-dangerous delete button for every kind of retire", () => {
    for (const retire of [
      null,
      { count: 1, others: [OTHER_STATUS] },
      { blocked: "Choose another paid default before deleting this status" },
    ]) {
      const html = render(retire);
      assertStringIncludes(html, "Delete status");
      assert(!html.includes('class="danger"'));
    }
  });

  test("renders a rejected submit's error", () => {
    const html = render(null, "No one may hold nothing");

    assertStringIncludes(html, "No one may hold nothing");
  });

  test("leaves the error box out when the operator just opened the page", () => {
    assert(!render(null).includes("error"));
  });

  test("says the save's prerequisite beside the confirmation for a default status", () => {
    const html = render({
      blocked: "Choose another paid default before deleting this status",
    });

    assertStringIncludes(
      html,
      "Choose another paid default before deleting this status",
    );
    assert(!html.includes('name="reassignStatusId"'));
    expectIncludesAll(html, [
      'action="/admin/settings/statuses/9/delete"',
      "Delete status",
    ]);
  });
});
