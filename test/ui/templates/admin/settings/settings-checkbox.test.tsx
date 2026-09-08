/** Direct tests for settings-checkbox.tsx — the shared settings-form checkbox
 *  and the data attributes that declare an either/or pair. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SettingsCheckbox } from "#templates/admin/settings/settings-checkbox.tsx";

describe("SettingsCheckbox", () => {
  test("posts true when ticked, with its label text beside it", () => {
    const html = String(
      SettingsCheckbox({ checked: true, label: "Enabled", name: "enabled" }),
    );
    expect(html).toContain('<input checked name="enabled"');
    expect(html).toContain('<input checked name="enabled" type="checkbox"');
    expect(html).toContain("> Enabled</label>");
    expect(html).toContain('type="checkbox" value="true"');
  });

  test("keeps the label unstyled when no class is asked for", () => {
    const html = String(
      SettingsCheckbox({
        checked: false,
        label: "Enabled",
        name: "enabled",
      }),
    );
    expect(html).not.toContain("class=");
  });

  test("styles the label when a class is asked for", () => {
    const html = String(
      SettingsCheckbox({
        checked: false,
        label: "Enabled",
        labelClass: "toggle",
        name: "enabled",
      }),
    );
    expect(html).toContain('<label class="toggle">');
  });

  test("declares an either/or pair as data attributes", () => {
    const html = String(
      SettingsCheckbox({
        checked: false,
        exclusive: {
          other: "is_reservation",
          why: "A paid status can't also be a reservation",
        },
        label: "Paid",
        name: "is_paid_default",
      }),
    );
    expect(html).toContain('data-exclusive-with="is_reservation"');
    expect(html).toContain(
      'data-exclusive-why="A paid status can\'t also be a reservation"',
    );
  });

  test("renders no data attributes when no pair is declared", () => {
    const html = String(
      SettingsCheckbox({
        checked: false,
        label: "Paid",
        name: "is_paid_default",
      }),
    );
    expect(html).not.toContain("data-exclusive");
  });
});
