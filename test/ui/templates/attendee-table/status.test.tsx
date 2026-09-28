import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { getCurrentCsrfToken } from "#shared/csrf.ts";
import {
  createStatusRenderer,
  noQuantityIndicator,
} from "#templates/attendee-table/status.tsx";
import type { AttendeeTableOptions } from "#templates/attendee-table/types.ts";
import { setupAdminPageTest } from "#test-utils/admin-page-test.ts";
import { testAttendee } from "#test-utils/factories.ts";
import type { Attendee, AttendeeTableRow } from "#types";
import { makeOpts, makeRow } from "./shared.ts";

const renderStatus = (
  attendee: Partial<Attendee> = {},
  options: Partial<AttendeeTableOptions> = {},
  listings: AttendeeTableRow["listings"] = [{ id: 9, name: "Show" }],
): string =>
  String(
    createStatusRenderer(makeOpts(options))(
      makeRow({ attendee: testAttendee(attendee), listings }),
    ),
  );

describe("attendee status cells", () => {
  beforeAll(setupAdminPageTest);

  test("renders the no-quantity indicator exactly", () => {
    expect(String(noQuantityIndicator())).toBe(
      '<span class="muted small">No quantity</span>',
    );
  });

  test("gives servicing status precedence over ticket state", () => {
    expect(
      renderStatus({ kind: "servicing", quantity: 0, refunded: true }),
    ).toBe(
      '<span class="servicing-event" data-servicing="true">Service</span>',
    );
  });

  test("gives no quantity precedence over refund and check-in actions", () => {
    const html = renderStatus({ quantity: 0, refunded: true });

    expect(html).toBe('<span class="muted small">No quantity</span>');
    expect(html).not.toContain("Refunded");
    expect(html).not.toContain("/checkin");
  });

  test("renders refunded tickets as an alert without a form", () => {
    const html = renderStatus({ refunded: true });

    expect(html).toBe('<span class="badge-alert">Refunded</span>');
    expect(html).not.toContain("<form");
  });

  test("renders an unchecked attendee with default return state", () => {
    const token = getCurrentCsrfToken();

    expect(renderStatus({ checked_in: 0, id: 7 })).toBe(
      '<form action="/admin/listing/9/attendee/7/checkin" autocomplete="off" method="POST" class="inline">' +
        `<input name="csrf_token" type="hidden" value="${token}">` +
        '<input name="check_in" type="hidden" value="true">' +
        '<input name="quantity" type="hidden" value="1">' +
        '<input name="return_filter" type="hidden" value="all">' +
        '<button class="link-button checkin" type="submit">Check in</button></form>',
    );
  });

  test("renders a checked-in attendee with supplied return state", () => {
    const html = renderStatus(
      { checked_in: 1, id: 8 },
      { activeFilter: "in", returnUrl: "/admin/checkin/today" },
    );

    expect(html).toContain('action="/admin/listing/9/attendee/8/checkin"');
    expect(html).toContain(
      '<input name="return_filter" type="hidden" value="in">',
    );
    expect(html).toContain(
      '<input name="return_url" type="hidden" value="/admin/checkin/today">',
    );
    expect(html).toContain(
      '<button class="link-button checkout" type="submit">Check out</button>',
    );
  });

  test("links a multi-ticket line to the quantity page", () => {
    const html = renderStatus(
      { checked_in: 0, id: 11, quantity: 3 },
      { activeFilter: "out", returnUrl: "/admin/checkin/today" },
    );

    expect(html).toContain(
      'href="/admin/listing/9/attendee/11/checkin' +
        '?return_url=%2Fadmin%2Fcheckin%2Ftoday&amp;return_filter=out"',
    );
    expect(html).toContain('<a class="link-button checkin"');
    expect(html).not.toContain("Check out");
  });

  test("a partly admitted multi-ticket line offers both directions", () => {
    const html = renderStatus({ checked_in: 1, id: 12, quantity: 3 });

    expect(html).toContain('<a class="link-button checkin"');
    expect(html).toContain('<a class="link-button checkout"');
    expect(html).toContain('href="/admin/listing/9/attendee/12/checkin"');
  });

  test("picks the control from the pair's booking, not the row's line", () => {
    // One qty-1 line of a two-line pair: the check-in write moves the pair,
    // so the row links to the quantity page instead.
    const html = String(
      createStatusRenderer(makeOpts())(
        makeRow({
          attendee: testAttendee({ checked_in: 0, id: 13, quantity: 1 }),
          booking: { checked_in: 0, quantity: 2 },
          listings: [{ id: 9, name: "Show" }],
        }),
      ),
    );

    expect(html).toContain('<a class="link-button checkin"');
    expect(html).not.toContain("<form");
  });

  test("a pair holding one ticket keeps the direct toggle", () => {
    const html = String(
      createStatusRenderer(makeOpts())(
        makeRow({
          attendee: testAttendee({ checked_in: 0, id: 14, quantity: 1 }),
          booking: { checked_in: 0, quantity: 1 },
          listings: [{ id: 9, name: "Show" }],
        }),
      ),
    );

    expect(html).toContain('<button class="link-button checkin"');
  });

  test("throws when a check-in row has no listing", () => {
    expect(() => renderStatus({ id: 42 }, {}, [])).toThrow(
      "Attendee 42 has no listing",
    );
  });
});
