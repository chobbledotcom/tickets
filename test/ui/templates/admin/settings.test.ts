import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { adminSettingsPage } from "#templates/admin/settings.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { hasCheckedInput } from "#test-utils/csrf.ts";
import { defaultSettingsState } from "./settings-state.ts";

describe("adminSettingsPage", () => {
  beforeAll(setupAdminPageTest);

  test("renders the underline-links checkbox, unchecked by default", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain("Underline links");
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    expect(checkbox?.[0]).toContain('type="checkbox"');
    expect(checkbox?.[0]).not.toContain("checked");
  });

  test("checks the underline-links checkbox when enabled", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      underlineLinks: true,
    });
    const checkbox = html.match(/<input[^>]*name="underline_links"[^>]*>/);
    expect(checkbox?.[0]).toContain("checked");
  });

  test("shows settings sub-navigation", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain('href="/admin/settings-advanced"');
    expect(html).toContain('href="/admin/backup"');
    expect(html).toContain('href="/admin/debug"');
  });

  test("renders the calendar feeds form as markup, not escaped HTML", () => {
    const html = adminSettingsPage(OWNER_SESSION, defaultSettingsState());
    expect(html).toContain('action="/admin/settings/calendar-feeds"');
    expect(html).toContain('name="calendar_feeds_enabled"');
    expect(html).toContain('name="calendar_feeds_group_by"');
    expect(html).not.toContain("&lt;form");
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
    expect(html).not.toContain('action="/admin/settings/booking-fee"');
  });

  test("asks for a booking fee percentage between 0 and 10", () => {
    const html = adminSettingsPage(OWNER_SESSION, {
      ...defaultSettingsState(),
      bookingFee: "2.5",
      paymentProvider: "stripe",
    });
    expect(html).toContain('action="/admin/settings/booking-fee"');
    expect(html).toContain('id="settings-booking-fee"');
    const input = html.match(/<input[^>]*name="booking_fee"[^>]*>/)?.[0];
    expect(input).toContain('type="number"');
    expect(input).toContain('min="0"');
    expect(input).toContain('max="10"');
    expect(input).toContain('step="0.1"');
    expect(input).toContain('value="2.5"');
  });
});
