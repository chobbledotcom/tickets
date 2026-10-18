import { assert, assertStringIncludes } from "@std/assert";
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
    assertStringIncludes(render(), 'action="/admin/listing-defaults"');
  });

  test("offers the logistics default when the feature is on", () => {
    assertStringIncludes(render({}, true), "default_uses_logistics");
  });

  test("leaves the logistics default out when the feature is off", () => {
    assert(!render({}, false).includes("default_uses_logistics"));
  });

  test("draws a number control for a number default", () => {
    const html = render({ minimumDaysBefore: 3 });
    assertStringIncludes(html, 'name="default_minimum_days_before"');
    assertStringIncludes(html, 'value="3"');
  });

  test("draws a url control for a url default", () => {
    const html = render({ webhookUrl: "https://example.com/hook" });
    assertStringIncludes(html, 'name="default_webhook_url"');
    assertStringIncludes(html, "https://example.com/hook");
  });

  test("draws the day checkboxes, ticked for the chosen days", () => {
    const html = render({ bookableDays: ["Monday"] });
    assertStringIncludes(html, "default_bookable_days_enabled");
    assertStringIncludes(html, "Monday");
  });

  test("offers no default, yes and no for a true/false default", () => {
    const html = render({}, true);
    assertStringIncludes(html, "No default");
    assertStringIncludes(html, 'value="1"');
    assertStringIncludes(html, 'value="0"');
  });

  test("shows an error above the form when one is given", () => {
    const html = adminListingDefaultsPage(OWNER_SESSION, {}, true, "Nope");
    assertStringIncludes(html, "Nope");
  });

  test("shows a success message when one is given", () => {
    const html = adminListingDefaultsPage(
      OWNER_SESSION,
      {},
      true,
      undefined,
      "Saved",
    );
    assertStringIncludes(html, "Saved");
  });
});
