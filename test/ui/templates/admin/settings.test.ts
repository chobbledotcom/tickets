import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { says } from "#test-utils/says.ts";
import { defaultSettingsState } from "./settings-state.ts";

describe("adminSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the underline-links checkbox, unchecked by default", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    says(html, "Underline links");
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    const cell = checkbox?.[0];
    says(cell, 'type="checkbox"');
    assert(
      cell !== undefined && !cell.includes("checked"),
      "the value should not contain the searched item",
    );
  });

  test("checks the underline-links checkbox when enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      underlineLinks: true,
    });
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    says(checkbox?.[0], "checked");
  });

  test("shows settings sub-navigation", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    says(html, 'href="/admin/settings-advanced"');
    says(html, 'href="/admin/backup"');
    says(html, 'href="/admin/debug"');
  });

  test("renders the calendar feeds form as markup, not escaped HTML", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    says(html, 'action="/admin/settings/calendar-feeds"');
    says(html, 'name="calendar_feeds_enabled"');
    says(html, 'name="calendar_feeds_group_by"');
    assert(!html.includes("&lt;form"));
  });

  test("checks the calendar feeds toggle when enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      calendarFeedsEnabled: true,
    });
    expect(hasCheckedInput(html, "calendar_feeds_enabled", "true")).toBe(true);
  });

  test("hides the booking fee form until a payment provider is chosen", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    assert(!html.includes('action="/admin/settings/booking-fee"'));
  });

  test("asks for a booking fee percentage between 0 and 10", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      bookingFee: "2.5",
      paymentProvider: "stripe",
    });
    says(html, 'action="/admin/settings/booking-fee"');
    says(html, 'id="settings-booking-fee"');
    const input = html.match(/<input[^>]*name="booking_fee"[^>]*>/)?.[0];
    says(input, 'type="number"');
    says(input, 'min="0"');
    says(input, 'max="10"');
    says(input, 'step="0.1"');
    says(input, 'value="2.5"');
  });
});
