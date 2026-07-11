import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { t } from "#i18n";
import { booleanSettingsSection } from "#templates/admin/settings/boolean-settings-section.tsx";

type TestState = { enabled: boolean };

const section = booleanSettingsSection<TestState>({
  action: "/admin/settings/test-toggle",
  description: <p>A test toggle.</p>,
  fieldName: "test_enabled",
  submitLabel: t("common.save"),
  title: "Test toggle",
  value: (s) => s.enabled,
});

describe("booleanSettingsSection", () => {
  test("renders the SettingsSection shell with action, title, and description", () => {
    const html = String(section({ enabled: false }));
    expect(html).toContain('action="/admin/settings/test-toggle"');
    expect(html).toContain("<h2>Test toggle</h2>");
    expect(html).toContain("<p>A test toggle.</p>");
    expect(html).toContain('id="settings-test-toggle"');
  });

  test("renders the save button under the radios", () => {
    const html = String(section({ enabled: false }));
    expect(html).toContain('name="test_enabled"');
    expect(html).toContain(t("common.save"));
  });

  test("checks the yes radio when the state is on and the no radio when off", () => {
    const onHtml = String(section({ enabled: true }));
    const offHtml = String(section({ enabled: false }));
    const yesRadio =
      '<input checked name="test_enabled" type="radio" value="true">';
    const noRadio =
      '<input checked name="test_enabled" type="radio" value="false">';
    // Both render both options; exactly one carries checked, on the right side.
    expect(onHtml).toContain(yesRadio);
    expect(onHtml).not.toContain(noRadio);
    expect(offHtml).toContain(noRadio);
    expect(offHtml).not.toContain(yesRadio);
  });

  test("falls back to common.save when submitLabel is omitted", () => {
    const noLabel = booleanSettingsSection<TestState>({
      action: "/admin/settings/no-label",
      description: <p>No label.</p>,
      fieldName: "x",
      title: "No label",
      value: (s) => s.enabled,
    });
    expect(String(noLabel({ enabled: false }))).toContain(t("common.save"));
  });
});
