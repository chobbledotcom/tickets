import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import type { ListingDefaults } from "#shared/listing-defaults.ts";
import { adminListingDefaultsPage } from "#templates/admin/listing-defaults.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";

const render = (defaults: ListingDefaults = {}, hasLogistics = true): string =>
  adminListingDefaultsPage(OWNER_SESSION, defaults, hasLogistics);

describe("adminListingDefaultsPage", () => {
  beforeAll(setupAdminPageTest);

  test("posts back to its own path", () => {
    expect(render()).toContain('action="/admin/listing-defaults"');
  });

  test("offers the logistics default when the feature is on", () => {
    expect(render({}, true)).toContain("default_uses_logistics");
  });

  test("leaves the logistics default out when the feature is off", () => {
    expect(render({}, false)).not.toContain("default_uses_logistics");
  });

  test("draws a number control for a number default", () => {
    const html = render({ minimumDaysBefore: 3 });
    expect(html).toContain('name="default_minimum_days_before"');
    expect(html).toContain('value="3"');
  });

  test("draws a url control for a url default", () => {
    const html = render({ webhookUrl: "https://example.com/hook" });
    expect(html).toContain('name="default_webhook_url"');
    expect(html).toContain("https://example.com/hook");
  });

  test("draws the day checkboxes, ticked for the chosen days", () => {
    const html = render({ bookableDays: ["Monday"] });
    expect(html).toContain("default_bookable_days_enabled");
    expect(html).toContain("Monday");
  });

  test("offers no default, yes and no for a true/false default", () => {
    const html = render({}, true);
    expect(html).toContain("No default");
    expect(html).toContain('value="1"');
    expect(html).toContain('value="0"');
  });

  test("shows an error above the form when one is given", () => {
    const html = adminListingDefaultsPage(OWNER_SESSION, {}, true, "Nope");
    expect(html).toContain("Nope");
  });

  test("shows a success message when one is given", () => {
    const html = adminListingDefaultsPage(
      OWNER_SESSION,
      {},
      true,
      undefined,
      "Saved",
    );
    expect(html).toContain("Saved");
  });
});
