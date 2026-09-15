import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SettingsGuideFooter } from "#templates/admin/settings/guide-footer.tsx";

describe("SettingsGuideFooter", () => {
  test("links the settings section of the guide with its own label", () => {
    const html = String(SettingsGuideFooter());
    expect(html).toContain('href="/admin/guide#settings"');
    expect(html).toContain("Settings guide");
  });

  test("renders the staff-only guide footer scaffold", () => {
    const html = String(SettingsGuideFooter());
    expect(html).toContain('class="guide-footer"');
    expect(html).toContain('class="guide-link"');
  });
});
