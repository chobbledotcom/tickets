import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { AttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { FormParams } from "#shared/form-data.ts";
import {
  AttendeeStatusEditPanel,
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

    expect(html).toContain('href="/admin/settings/statuses/new"');
    expect(html).toContain('href="/admin/settings/statuses/7"');
    expect(html).toContain(
      '<span class="badge">Public default</span><span class="badge">Paid</span><span class="badge">Reservation: 25%</span>',
    );
    expect(html).not.toContain("Reservation: 0");
    expect(html).toContain('action="/admin/settings/statuses/7/move-down"');
    expect(html).not.toContain('action="/admin/settings/statuses/7/move-up"');
    expect(html).toContain('action="/admin/settings/statuses/8/move-up"');
    expect(html).not.toContain('action="/admin/settings/statuses/8/move-down"');
    expect(html).toContain('title="Move down"');
    expect(html).toContain('title="Move up"');
  });

  test("keeps status data but removes write controls in read-only mode", () => {
    using _env = withEnv({ READ_ONLY_FROM: "2020-01-01T00:00:00.000Z" });
    const html = statusPages.listPage([RESERVED_STATUS], OWNER_SESSION);

    expect(html).toContain("Reserved");
    expect(html).toContain("Reservation: 25%");
    expect(html).not.toContain('href="/admin/settings/statuses/new"');
    expect(html).not.toContain('href="/admin/settings/statuses/7"');
    expect(html).not.toContain("/move-");
  });

  test("renders blank create fields with the reservation default", () => {
    const html = statusPages.newPage(OWNER_SESSION);

    expect(html).toContain('action="/admin/settings/statuses"');
    expect(html).toMatch(/name="name"[^>]*value=""/);
    expect(html).toContain('name="is_reservation" type="checkbox"');
    expect(html).not.toContain('checked name="is_reservation"');
    expect(html).not.toContain('checked name="is_public_default"');
    expect(html).not.toContain('checked name="is_paid_default"');
    expect(html).toMatch(/name="reservation_amount"[^>]*value="0"/);
    expect(html).toContain("Create status");
  });

  test("prefills every stored edit field", () => {
    const html = String(AttendeeStatusEditPanel({ status: RESERVED_STATUS }));

    expect(html).toContain('action="/admin/settings/statuses/7/edit"');
    expect(html).toMatch(/name="name"[^>]*value="Reserved"/);
    expect(html.match(/<input checked name="is_/g)).toHaveLength(3);
    expect(html).toMatch(/name="reservation_amount"[^>]*value="25%"/);
    expect(html).toContain("Save status");
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

    expect(html).toContain("Invalid reservation amount");
    expect(html).toMatch(/name="name"[^>]*value=""/);
    expect(html).not.toContain('value="Reserved"');
    expect(html).not.toContain('checked name="is_reservation"');
    expect(html).toContain('checked name="is_public_default"');
    expect(html).not.toContain('checked name="is_paid_default"');
    expect(html).toMatch(/name="reservation_amount"[^>]*value="lots"/);
  });

  test("renders a non-dangerous typed-name delete form", () => {
    const html = statusPages.deletePage(
      RESERVED_STATUS,
      OWNER_SESSION,
      "Status is still in use",
    );

    expect(html).toContain("Status is still in use");
    expect(html).toContain('action="/admin/settings/statuses/7/delete"');
    expect(html).toContain(
      "Type the status name &quot;Reserved&quot; to confirm deletion:",
    );
    expect(html).toContain('name="confirm_identifier"');
    expect(html).toContain("Delete status");
    expect(html).not.toContain('<button class="danger"');
  });
});
