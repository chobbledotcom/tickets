import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { attendeeTaxSavedMessage } from "#routes/admin/attendee-tax.ts";
import { parseTaxSettingsForm } from "#routes/admin/settings-tax.ts";
import { FormParams } from "#shared/form-data.ts";
import type { TaxPolicy } from "#shared/tax/types.ts";
import { TaxSaveFields } from "#templates/admin/attendee-form/tax.tsx";
import { hasCheckedInput, inputTagWithValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
import { adminFormPost, getTestSession } from "#test-utils/session.ts";

const formOf = (entries: Record<string, string>): FormParams => {
  const form = new FormParams();
  for (const [key, value] of Object.entries(entries)) form.set(key, value);
  return form;
};

const settingsForm = (entries: Record<string, string>): FormParams =>
  formOf({
    expected_tax: JSON.stringify({ mode: "none" }),
    ...entries,
  });

describe("parseTaxSettingsForm", () => {
  test("accepts none with a blank rate", () => {
    const parsed = parseTaxSettingsForm(
      settingsForm({ tax_mode: "none", tax_rate: "" }),
    );
    expect(parsed).toEqual({
      expected: { mode: "none" },
      ok: true,
      policy: { mode: "none" },
    });
  });

  test("accepts none with a rate typed in", () => {
    const parsed = parseTaxSettingsForm(
      settingsForm({ tax_mode: "none", tax_rate: "20" }),
    );
    expect(parsed).toEqual({
      expected: { mode: "none" },
      ok: true,
      policy: { mode: "none" },
    });
  });

  test("parses a rate into basis points", () => {
    const parsed = parseTaxSettingsForm(
      settingsForm({ tax_mode: "add_to_total", tax_rate: "20.5" }),
    );
    expect(parsed).toEqual({
      expected: { mode: "none" },
      ok: true,
      policy: { mode: "add_to_total", rateBasisPoints: 2050 },
    });
  });

  test("refuses an unknown mode", () => {
    const parsed = parseTaxSettingsForm(
      settingsForm({ tax_mode: "wat", tax_rate: "" }),
    );
    expect(parsed).toEqual({
      error: "Tax settings are invalid. Reload the page and try again.",
      ok: false,
    });
  });

  test("refuses a rate that is not a number", () => {
    const parsed = parseTaxSettingsForm(
      settingsForm({ tax_mode: "add_to_total", tax_rate: "twenty" }),
    );
    expect(parsed).toEqual({
      error: "Enter a non-negative tax rate with at most two decimal places.",
      ok: false,
    });
  });

  test("refuses an unreadable stored expected policy", () => {
    const parsed = parseTaxSettingsForm(
      formOf({ expected_tax: "{", tax_mode: "none", tax_rate: "" }),
    );
    expect(parsed).toEqual({
      error: "Tax settings are invalid. Reload the page and try again.",
      ok: false,
    });
  });

  test("treats a missing rate field as blank", () => {
    const parsed = parseTaxSettingsForm(settingsForm({ tax_mode: "none" }));
    expect(parsed).toEqual({
      expected: { mode: "none" },
      ok: true,
      policy: { mode: "none" },
    });
  });
});

describe("attendeeTaxSavedMessage", () => {
  test("reports the tax and balance change when the assessment changed", () => {
    const message = attendeeTaxSavedMessage("Dana", {
      afterBalance: 12000,
      afterTax: 2000,
      beforeBalance: 10000,
      beforeTax: 0,
      changed: true,
      token: "t",
    });
    assertStringIncludes(message, "Saved Dana");
    assertStringIncludes(message, "Tax changed from £0 to £20");
    assertStringIncludes(message, "balance changed from £100 to £120");
  });

  test("reports the plain update when the assessment did not change", () => {
    const message = attendeeTaxSavedMessage("Dana", {
      afterBalance: 10000,
      afterTax: 0,
      beforeBalance: 10000,
      beforeTax: 0,
      changed: false,
      token: "t",
    });
    expect(message).toBe("Updated Dana");
  });
});

describe("TaxSaveFields", () => {
  test("explains the pending change and carries the preview token", () => {
    const html = String(
      TaxSaveFields({
        preview: {
          afterBalance: 12000,
          afterTax: 2000,
          beforeBalance: 10000,
          beforeTax: 0,
          changed: true,
          token: "tok-1",
        },
      }),
    );
    assertStringIncludes(html, 'name="tax_preview"');
    assertStringIncludes(html, 'value="tok-1"');
    assertStringIncludes(
      html,
      "Your Tax settings changed. Save this attendee to apply them",
    );
    assertStringIncludes(html, "Amount");
    assertStringIncludes(html, "Saved now");
    assertStringIncludes(html, "After you save");
    assertStringIncludes(html, "£20");
    assertStringIncludes(html, "£120");
  });

  test("explains that the booking already uses the current settings", () => {
    const html = String(
      TaxSaveFields({
        preview: {
          afterBalance: 10000,
          afterTax: 0,
          beforeBalance: 10000,
          beforeTax: 0,
          changed: false,
          token: "tok-2",
        },
      }),
    );
    assertStringIncludes(
      html,
      "This booking already uses your current Tax settings",
    );
  });
});

/** Stores the given policy, then posts the site's tax form, which asks for
 *  the given added rate while expecting the policy it read. The fixed
 *  expected policy is what makes the stale save refused. */
const postTaxForm = async (stored: TaxPolicy, rate: string) => {
  await settings.update.tax(stored);
  return adminFormPost("/admin/settings/tax", {
    expected_tax: JSON.stringify({ mode: "none" }),
    tax_mode: "add_to_total",
    tax_rate: rate,
  });
};

describeWithEnv("server (settings form) — tax save", { db: true }, () => {
  test("saves a tax choice through the settings form", async () => {
    const { response, cookie } = await postTaxForm({ mode: "none" }, "20");
    expect(response.status).toBe(302);
    expect(settings.tax).toEqual({
      mode: "add_to_total",
      rateBasisPoints: 2000,
    });
    const page = await awaitTestRequest("/admin/settings", { cookie });
    const html = await page.text();
    expect(hasCheckedInput(html, "tax_mode", "add_to_total")).toBe(true);
    expect(inputTagWithValue(html, "20.00", "tax_rate")).not.toBe("");
  });

  test("refuses a rate the site cannot store", async () => {
    const { response } = await postTaxForm(
      { mode: "none" },
      "99999999999999999999",
    );
    expect(response.status).toBe(302);
    expect(settings.tax).toEqual({ mode: "none" });
  });

  test("refuses a save whose stored setting has moved", async () => {
    const { response } = await postTaxForm(
      { mode: "add_to_total", rateBasisPoints: 2000 },
      "20",
    );
    expect(response.status).toBe(302);
    expect(settings.tax).toEqual({
      mode: "add_to_total",
      rateBasisPoints: 2000,
    });
  });

  test("shows an empty rate box when the site collects no tax", async () => {
    await settings.update.tax({ mode: "none" });
    const { cookie } = await getTestSession();
    const page = await awaitTestRequest("/admin/settings", { cookie });
    const html = await page.text();
    expect(hasCheckedInput(html, "tax_mode", "none")).toBe(true);
    expect(inputTagWithValue(html, "", "tax_rate")).not.toBe("");
  });
});
