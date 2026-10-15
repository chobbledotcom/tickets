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
import { withEnv } from "#test-utils/env.ts";

const RESERVED_STATUS: AttendeeStatus = {
  id: 7,
  is_paid_default: true,
  is_public_default: true,
  is_reservation: true,
  name: "Reserved",
  reservation_amount: "25%",
  sort_order: 0,
};

const PLAIN_STATUS: AttendeeStatus = {
  id: 8,
  is_paid_default: false,
  is_public_default: false,
  is_reservation: false,
  name: "Checked in",
  reservation_amount: "0",
  sort_order: 1,
};

describe("attendee status templates", () => {
  beforeAll(setupAdminPageTest);

  test("renders writable status rows with flags and boundary-aware moves", () => {
    using _env = withEnv({ READ_ONLY_FROM: undefined });
    const html = statusPages.listPage(
      [RESERVED_STATUS, PLAIN_STATUS],
      OWNER_SESSION,
    );

    assertStringIncludes(html, 'href="/admin/settings/statuses/new"');
    assertStringIncludes(html, 'href="/admin/settings/statuses/7"');
    assertStringIncludes(
      html,
      '<span class="badge">Public default</span><span class="badge">Paid</span><span class="badge">Reservation: 25%</span>',
    );
    assert(
      !html.includes("Reservation: 0"),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'action="/admin/settings/statuses/7/move-down"');
    assert(
      !html.includes('action="/admin/settings/statuses/7/move-up"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'action="/admin/settings/statuses/8/move-up"');
    assert(
      !html.includes('action="/admin/settings/statuses/8/move-down"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'title="Move down"');
    assertStringIncludes(html, 'title="Move up"');
  });

  test("keeps status data but removes write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = statusPages.listPage([RESERVED_STATUS], OWNER_SESSION);

    assertStringIncludes(html, "Reserved");
    assertStringIncludes(html, "Reservation: 25%");
    assert(
      !html.includes('href="/admin/settings/statuses/new"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('href="/admin/settings/statuses/7"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("/move-"),
      "the value should not contain the searched item",
    );
  });

  test("renders blank create fields with the reservation default", () => {
    const html = statusPages.newPage(OWNER_SESSION);

    assertStringIncludes(html, 'action="/admin/settings/statuses"');
    expect(html).toMatch(/name="name"[^>]*value=""/);
    assertStringIncludes(html, 'name="is_reservation" type="checkbox"');
    assert(
      !html.includes('checked name="is_reservation"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('checked name="is_public_default"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes('checked name="is_paid_default"'),
      "the value should not contain the searched item",
    );
    expect(html).toMatch(/name="reservation_amount"[^>]*value="0"/);
    assertStringIncludes(html, "Create status");
  });

  test("prefills every stored edit field", () => {
    const html = String(AttendeeStatusEditPanel({ status: RESERVED_STATUS }));

    assertStringIncludes(html, 'action="/admin/settings/statuses/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Reserved"/);
    expect(html.match(/<input checked/g)).toHaveLength(3);
    expect(html).toMatch(/name="reservation_amount"[^>]*value="25%"/);
    assertStringIncludes(html, "Save status");
  });

  test("uses rejected values instead of restoring stored edit fields", () => {
    const values = new FormParams({
      is_public_default: "true",
      reservation_amount: "lots",
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
    assert(
      !html.includes('value="Reserved"'),
      "the value should not contain the searched item",
    );
    expect(html).not.toMatch(/<input checked[^>]*name="is_reservation"/);
    expect(html).toMatch(/<input checked[^>]*name="is_public_default"/);
    expect(html).not.toMatch(/<input checked[^>]*name="is_paid_default"/);
    expect(html).toMatch(/name="reservation_amount"[^>]*value="lots"/);
  });

  test("gives every field the shape the browser needs", () => {
    const html = statusPages.newPage(OWNER_SESSION);

    assertStringIncludes(
      html,
      '<input maxlength="250" name="name" required type="text"',
    );
    assertStringIncludes(html, '<input name="reservation_amount" type="text"');
    assertStringIncludes(html, '<fieldset class="checkboxes">');
    assertStringIncludes(html, '<label class="checkbox">');
  });

  test("pairs the paid-default and reservation checkboxes so only one can hold", () => {
    // Checking either one disables the other and shows why; the server
    // refusal stays the authority for a stale or tampered submit.
    const html = statusPages.newPage(OWNER_SESSION);

    expect(html).toMatch(
      /data-exclusive-with="is_reservation"[^>]*name="is_paid_default"/,
    );
    expect(html).toMatch(
      /data-exclusive-with="is_paid_default"[^>]*name="is_reservation"/,
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
      is_paid_default: "true",
      is_reservation: "true",
      name: "Typed Instead",
    });

    const html = String(
      AttendeeStatusEditPanel({ status: PLAIN_STATUS, values }),
    );

    expect(html).toMatch(/name="name"[^>]*value="Typed Instead"/);
    expect(html).toMatch(/<input checked[^>]*name="is_reservation"/);
    expect(html).toMatch(/<input checked[^>]*name="is_paid_default"/);
    expect(html).not.toMatch(/<input checked[^>]*name="is_public_default"/);
  });

  test("renders a non-dangerous typed-name delete form", () => {
    const html = statusPages.deletePage(
      RESERVED_STATUS,
      OWNER_SESSION,
      "Status is still in use",
    );

    assertStringIncludes(html, "Status is still in use");
    assertStringIncludes(html, 'action="/admin/settings/statuses/7/delete"');
    assertStringIncludes(
      html,
      "Type the status name &quot;Reserved&quot; to confirm deletion:",
    );
    assertStringIncludes(html, 'name="confirm_identifier"');
    assertStringIncludes(html, "Delete status");
    assert(
      !html.includes('<button class="danger"'),
      "the value should not contain the searched item",
    );
  });
});

describe("the delete page of a status attendees hold", () => {
  beforeAll(setupAdminPageTest);

  const BUSY_STATUS: AttendeeStatus = {
    id: 9,
    is_paid_default: false,
    is_public_default: false,
    is_reservation: false,
    name: "Busy",
    reservation_amount: "0",
    sort_order: 2,
  };
  const OTHER_STATUS: AttendeeStatus = { ...PLAIN_STATUS, id: 8 };

  const render = (
    retire: StatusRetire | null,
    error?: string,
  ): ReturnType<typeof String> =>
    String(retireStatusDeletePage(BUSY_STATUS, retire, OWNER_SESSION, error));

  test("shows the count, a warning, and a required picker of the other statuses", () => {
    const html = render({ count: 1, others: [OTHER_STATUS] });

    assertStringIncludes(html, "1 attendee holds this status.");
    assertStringIncludes(html, t("statuses.delete_reassign_warning"));
    expect(html).toMatch(/<select[^>]*name="reassign_status_id"[^>]*required/);
    // The empty prompt stays preselected, so a save without a real pick
    // cannot slip through the browser's own required check.
    assertStringIncludes(html, '<option selected value="">');
    assertStringIncludes(html, t("statuses.delete_reassign_prompt"));
    assertStringIncludes(html, 'value="8"');
    assertStringIncludes(html, "Checked in");
  });

  test("keeps the picker off a status nobody holds", () => {
    const html = render(null);

    assert(
      !html.includes('name="reassign_status_id"'),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes(t("statuses.delete_reassign_warning")),
      "the value should not contain the searched item",
    );
  });

  test("renders a rejected submit's error", () => {
    const html = render(null, "No one may hold nothing");

    assertStringIncludes(html, "No one may hold nothing");
  });

  test("leaves the error box out when the operator just opened the page", () => {
    assert(
      !render(null).includes("error"),
      "the value should not contain the searched item",
    );
  });

  test("says the save's prerequisite beside the confirmation for a default status", () => {
    const html = render({
      blocked: "Choose another paid default before deleting this status",
    });

    assertStringIncludes(
      html,
      "Choose another paid default before deleting this status",
    );
    assert(
      !html.includes('name="reassign_status_id"'),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, 'action="/admin/settings/statuses/9/delete"');
    assertStringIncludes(html, "Delete status");
  });
});
